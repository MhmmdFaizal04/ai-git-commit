#!/usr/bin/env node
/**
 * ai-git-commit — AI-powered git commit message generator
 *
 * Usage:
 *   git add .
 *   aic                    → generate + confirm + commit
 *   aic --dry-run          → generate only, don't commit
 *   aic --provider ollama  → use local Ollama LLM
 *   aic setup              → interactive setup wizard
 *   aic config             → show current config
 */

import { execSync, exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import prompts from 'prompts'

const execAsync = promisify(exec)
const VERSION = '1.0.0'

// ─── Types ────────────────────────────────────────────────────────────────────

type Provider = 'openai' | 'anthropic' | 'ollama'
type CommitType = 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'test' | 'chore' | 'perf' | 'ci' | 'build' | 'revert'

interface Config {
  provider: Provider
  apiKey?: string
  model: string
  ollamaUrl: string
  maxDiffLength: number
  locale: string
  commitTypes: CommitType[]
  includeBody: boolean
  emojiStyle: 'none' | 'gitmoji'
}

interface GeneratedCommit {
  type: CommitType
  scope?: string
  subject: string
  body?: string
  breaking: boolean
  full: string
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.aiccommit.json')

const DEFAULT_CONFIG: Config = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  ollamaUrl: 'http://localhost:11434',
  maxDiffLength: 6000,
  locale: 'en',
  commitTypes: ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf'],
  includeBody: false,
  emojiStyle: 'none',
}

function loadConfig(): Config {
  // 1. Start with defaults
  let config = { ...DEFAULT_CONFIG }

  // 2. Load from ~/.aiccommit.json
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      config = { ...config, ...saved }
    } catch { /* ignore parse errors */ }
  }

  // 3. Load from project-level .aiccommit.json
  const projectConfig = path.join(process.cwd(), '.aiccommit.json')
  if (fs.existsSync(projectConfig)) {
    try {
      const saved = JSON.parse(fs.readFileSync(projectConfig, 'utf-8'))
      config = { ...config, ...saved }
    } catch { /* ignore */ }
  }

  // 4. Environment variables override everything
  if (process.env.OPENAI_API_KEY) config.apiKey = process.env.OPENAI_API_KEY
  if (process.env.ANTHROPIC_API_KEY) { config.apiKey = process.env.ANTHROPIC_API_KEY; config.provider = 'anthropic' }
  if (process.env.AIC_PROVIDER) config.provider = process.env.AIC_PROVIDER as Provider
  if (process.env.AIC_MODEL) config.model = process.env.AIC_MODEL

  return config
}

function saveConfig(config: Partial<Config>): void {
  const existing = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    : {}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...config }, null, 2))
}

// ─── Git Helpers ──────────────────────────────────────────────────────────────

function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function getStagedDiff(maxLength: number): string {
  try {
    const diff = execSync('git diff --staged --no-color', { encoding: 'utf-8' })
    if (!diff.trim()) return ''
    // Truncate if too long to save tokens
    return diff.length > maxLength ? diff.slice(0, maxLength) + '\n\n[... diff truncated ...]' : diff
  } catch {
    return ''
  }
}

function getStagedFiles(): string[] {
  try {
    const output = execSync('git diff --staged --name-status', { encoding: 'utf-8' })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function getRecentCommits(n = 5): string {
  try {
    return execSync(`git log --oneline -${n} 2>/dev/null`, { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

function runGitCommit(message: string): void {
  const escaped = message.replace(/"/g, '\\"').replace(/`/g, '\\`')
  execSync(`git commit -m "${escaped}"`, { stdio: 'inherit' })
}

// ─── AI Providers ─────────────────────────────────────────────────────────────

function buildPrompt(diff: string, files: string[], recentCommits: string, config: Config): string {
  const emojiMap: Record<CommitType, string> = {
    feat: '✨', fix: '🐛', docs: '📝', style: '💄', refactor: '♻️',
    test: '✅', chore: '🔧', perf: '⚡️', ci: '👷', build: '📦', revert: '⏪',
  }

  const commitTypeExamples = config.commitTypes.map(t =>
    config.emojiStyle === 'gitmoji' ? `${emojiMap[t]} ${t}: description` : `${t}: description`
  ).join('\n  ')

  return `You are an expert developer writing a git commit message.

STAGED FILES:
${files.slice(0, 20).join('\n')}

GIT DIFF:
${diff}

${recentCommits ? `RECENT COMMITS (for style reference):\n${recentCommits}\n` : ''}

INSTRUCTIONS:
- Write a concise, clear commit message following Conventional Commits spec
- Use one of these types: ${config.commitTypes.join(', ')}
- Subject line: imperative mood, max 72 chars, no period at end
- ${config.includeBody ? 'Include a brief body explaining WHY if the change is complex' : 'No body needed — subject line only'}
- If breaking change, add "BREAKING CHANGE:" in body or "!" after type
- Scope is optional — use it when change is limited to one area (e.g., feat(auth): ...)
- ${config.locale !== 'en' ? `Write in ${config.locale} language` : 'Write in English'}

FORMAT YOUR RESPONSE AS JSON:
{
  "type": "feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert",
  "scope": "optional-scope or null",
  "subject": "concise description in imperative mood",
  "body": "optional explanation or null",
  "breaking": false
}

EXAMPLES:
  ${commitTypeExamples}

Return ONLY the JSON. No explanation, no markdown, no code blocks.`
}

async function callOpenAI(prompt: string, config: Config): Promise<string> {
  if (!config.apiKey) throw new Error('OpenAI API key not set. Run: aic setup')

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 300,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error(`OpenAI error ${res.status}: ${(err as { error?: { message?: string } })?.error?.message ?? res.statusText}`)
  }

  const data = await res.json() as { choices: { message: { content: string } }[] }
  return data.choices[0]?.message?.content ?? ''
}

async function callAnthropic(prompt: string, config: Config): Promise<string> {
  if (!config.apiKey) throw new Error('Anthropic API key not set. Run: aic setup')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model.startsWith('claude') ? config.model : 'claude-3-haiku-20240307',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error(`Anthropic error ${res.status}: ${JSON.stringify(err)}`)
  }

  const data = await res.json() as { content: { text: string }[] }
  return data.content[0]?.text ?? ''
}

async function callOllama(prompt: string, config: Config): Promise<string> {
  const model = config.model.startsWith('gpt') || config.model.startsWith('claude')
    ? 'llama3.2'
    : config.model

  const res = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3 },
    }),
  }).catch(() => {
    throw new Error(`Cannot connect to Ollama at ${config.ollamaUrl}. Is Ollama running? Run: ollama serve`)
  })

  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${res.statusText}`)

  const data = await res.json() as { response: string }
  return data.response ?? ''
}

async function generateCommit(diff: string, files: string[], config: Config): Promise<GeneratedCommit> {
  const recentCommits = getRecentCommits()
  const prompt = buildPrompt(diff, files, recentCommits, config)

  let raw: string
  switch (config.provider) {
    case 'openai':    raw = await callOpenAI(prompt, config); break
    case 'anthropic': raw = await callAnthropic(prompt, config); break
    case 'ollama':    raw = await callOllama(prompt, config); break
    default: throw new Error(`Unknown provider: ${config.provider}`)
  }

  // Parse JSON response
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('AI returned invalid response — could not parse JSON')

  const parsed = JSON.parse(jsonMatch[0]) as {
    type: CommitType
    scope?: string | null
    subject: string
    body?: string | null
    breaking: boolean
  }

  const scope = parsed.scope ? `(${parsed.scope})` : ''
  const breaking = parsed.breaking ? '!' : ''
  const header = `${parsed.type}${scope}${breaking}: ${parsed.subject}`
  const full = parsed.body ? `${header}\n\n${parsed.body}` : header

  return {
    type: parsed.type,
    scope: parsed.scope ?? undefined,
    subject: parsed.subject,
    body: parsed.body ?? undefined,
    breaking: parsed.breaking,
    full,
  }
}

// ─── Display Helpers ──────────────────────────────────────────────────────────

const TYPE_COLORS: Record<CommitType, (s: string) => string> = {
  feat:     chalk.hex('#6c63ff'),
  fix:      chalk.hex('#f87171'),
  docs:     chalk.hex('#60a5fa'),
  style:    chalk.hex('#f472b6'),
  refactor: chalk.hex('#fb923c'),
  test:     chalk.hex('#4ade80'),
  chore:    chalk.hex('#9ca3af'),
  perf:     chalk.hex('#facc15'),
  ci:       chalk.hex('#818cf8'),
  build:    chalk.hex('#a78bfa'),
  revert:   chalk.hex('#f43f5e'),
}

const TYPE_EMOJI: Record<CommitType, string> = {
  feat: '✨', fix: '🐛', docs: '📝', style: '💄', refactor: '♻️',
  test: '✅', chore: '🔧', perf: '⚡️', ci: '👷', build: '📦', revert: '⏪',
}

function printBanner(): void {
  console.log('')
  console.log(chalk.bold.hex('#6c63ff')('  ai-git-commit') + chalk.gray(` v${VERSION}`))
  console.log(chalk.gray('  AI-powered commit message generator'))
  console.log('')
}

function printCommit(commit: GeneratedCommit): void {
  const colorFn = TYPE_COLORS[commit.type] ?? chalk.white
  const emoji = TYPE_EMOJI[commit.type] ?? ''

  console.log('')
  console.log(chalk.bold('  Generated commit:'))
  console.log('')
  console.log(
    '  ' +
    colorFn(`${commit.type}${commit.scope ? `(${commit.scope})` : ''}${commit.breaking ? '!' : ''}`) +
    chalk.white(`: ${commit.subject}`)
  )
  if (commit.body) {
    console.log('')
    commit.body.split('\n').forEach(line => console.log(chalk.gray(`  ${line}`)))
  }
  console.log('')
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const program = new Command()

program
  .name('aic')
  .description('AI-powered git commit message generator')
  .version(VERSION)

// ── Main generate command (default) ──
program
  .command('generate', { isDefault: true })
  .description('Generate and optionally commit with AI message')
  .option('-d, --dry-run', 'Generate message only — do not commit')
  .option('-p, --provider <provider>', 'AI provider: openai | anthropic | ollama')
  .option('-m, --model <model>', 'Model name (e.g. gpt-4o, claude-3-haiku, llama3.2)')
  .option('-y, --yes', 'Auto-commit without confirmation')
  .option('--no-body', 'Skip commit body generation')
  .action(async (opts) => {
    printBanner()

    // Validate git repo
    if (!isGitRepo()) {
      console.error(chalk.red('  Not a git repository.'))
      process.exit(1)
    }

    // Load config + apply CLI overrides
    const config = loadConfig()
    if (opts.provider) config.provider = opts.provider as Provider
    if (opts.model) config.model = opts.model
    if (opts.body === false) config.includeBody = false

    // Get staged diff
    const files = getStagedFiles()
    if (files.length === 0) {
      console.log(chalk.yellow('  No staged changes found.'))
      console.log(chalk.gray('  Run: git add <files> or git add .'))
      console.log('')
      process.exit(0)
    }

    console.log(chalk.bold(`  ${files.length} staged file${files.length > 1 ? 's' : ''}:`))
    files.slice(0, 8).forEach(f => console.log(chalk.gray(`  · ${f}`)))
    if (files.length > 8) console.log(chalk.gray(`  · ...and ${files.length - 8} more`))
    console.log('')

    const diff = getStagedDiff(config.maxDiffLength)

    // Generate commit
    const spinner = ora({
      text: `Generating commit message via ${chalk.hex('#6c63ff')(config.provider)}...`,
      color: 'magenta',
    }).start()

    let commit: GeneratedCommit
    try {
      commit = await generateCommit(diff, files, config)
      spinner.succeed(chalk.green('Commit message generated'))
    } catch (err) {
      spinner.fail(chalk.red('Generation failed'))
      console.error(chalk.red(`\n  ${(err as Error).message}`))
      console.error(chalk.gray('  Run `aic setup` to configure your API key.'))
      process.exit(1)
    }

    printCommit(commit)

    // Dry run — just show the message
    if (opts.dryRun) {
      console.log(chalk.gray('  Dry run — no commit made.'))
      console.log(chalk.cyan(`  ${commit.full}`))
      console.log('')
      process.exit(0)
    }

    // Auto-commit with -y flag
    if (opts.yes) {
      runGitCommit(commit.full)
      console.log(chalk.green('  Committed successfully.'))
      console.log('')
      process.exit(0)
    }

    // Interactive confirmation
    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { title: chalk.green('Commit') + chalk.gray(' — use this message'), value: 'commit' },
        { title: chalk.yellow('Edit') + chalk.gray(' — modify before committing'), value: 'edit' },
        { title: chalk.hex('#6c63ff')('Regenerate') + chalk.gray(' — generate another option'), value: 'regen' },
        { title: chalk.red('Cancel'), value: 'cancel' },
      ],
    })

    if (!action || action === 'cancel') {
      console.log(chalk.gray('  Cancelled.'))
      process.exit(0)
    }

    if (action === 'regen') {
      // Re-run the command
      console.log('')
      const spinner2 = ora({ text: 'Regenerating...', color: 'magenta' }).start()
      try {
        const newCommit = await generateCommit(diff, files, config)
        spinner2.succeed(chalk.green('New commit message generated'))
        printCommit(newCommit)
        const { confirm } = await prompts({
          type: 'confirm',
          name: 'confirm',
          message: 'Commit with this message?',
          initial: true,
        })
        if (confirm) {
          runGitCommit(newCommit.full)
          console.log(chalk.green('  Committed successfully.'))
        } else {
          console.log(chalk.gray('  Cancelled.'))
        }
      } catch (err) {
        spinner2.fail()
        console.error(chalk.red(`  ${(err as Error).message}`))
      }
      process.exit(0)
    }

    if (action === 'edit') {
      const { edited } = await prompts({
        type: 'text',
        name: 'edited',
        message: 'Edit commit message:',
        initial: commit.full,
      })
      if (edited?.trim()) {
        runGitCommit(edited.trim())
        console.log(chalk.green('  Committed successfully.'))
      } else {
        console.log(chalk.gray('  Cancelled.'))
      }
      process.exit(0)
    }

    // Commit
    runGitCommit(commit.full)
    console.log(chalk.green('  Committed successfully.'))
    console.log('')
  })

// ── setup command ──
program
  .command('setup')
  .description('Interactive setup wizard')
  .action(async () => {
    printBanner()
    console.log(chalk.bold('  Setup Wizard'))
    console.log(chalk.gray('  Config will be saved to ~/.aiccommit.json'))
    console.log('')

    const answers = await prompts([
      {
        type: 'select',
        name: 'provider',
        message: 'AI provider:',
        choices: [
          { title: 'OpenAI (GPT-4o, GPT-4o-mini)', value: 'openai' },
          { title: 'Anthropic (Claude)', value: 'anthropic' },
          { title: 'Ollama (local — free, no API key)', value: 'ollama' },
        ],
      },
      {
        type: (prev: string) => prev !== 'ollama' ? 'password' : null,
        name: 'apiKey',
        message: (prev: string) => prev === 'openai' ? 'OpenAI API key:' : 'Anthropic API key:',
        validate: (v: string) => v.length > 10 || 'Key too short',
      },
      {
        type: 'select',
        name: 'model',
        message: 'Model:',
        choices: (prev: string, values: { provider: string }) => {
          if (values.provider === 'openai') return [
            { title: 'gpt-4o-mini (fast & cheap — recommended)', value: 'gpt-4o-mini' },
            { title: 'gpt-4o (best quality)', value: 'gpt-4o' },
            { title: 'gpt-3.5-turbo (cheapest)', value: 'gpt-3.5-turbo' },
          ]
          if (values.provider === 'anthropic') return [
            { title: 'claude-3-haiku-20240307 (fast & cheap)', value: 'claude-3-haiku-20240307' },
            { title: 'claude-3-5-sonnet-20241022 (best quality)', value: 'claude-3-5-sonnet-20241022' },
          ]
          return [
            { title: 'llama3.2 (recommended)', value: 'llama3.2' },
            { title: 'mistral', value: 'mistral' },
            { title: 'codellama', value: 'codellama' },
            { title: 'deepseek-coder-v2', value: 'deepseek-coder-v2' },
          ]
        },
      },
      {
        type: 'confirm',
        name: 'includeBody',
        message: 'Include commit body (explains WHY)?',
        initial: false,
      },
      {
        type: 'select',
        name: 'emojiStyle',
        message: 'Emoji style:',
        choices: [
          { title: 'None — clean text', value: 'none' },
          { title: 'Gitmoji — ✨ feat: add feature', value: 'gitmoji' },
        ],
      },
    ])

    if (!answers.provider) {
      console.log(chalk.gray('\n  Setup cancelled.'))
      process.exit(0)
    }

    saveConfig(answers)
    console.log('')
    console.log(chalk.green('  Configuration saved to ~/.aiccommit.json'))
    console.log(chalk.gray('  Run `aic` in any git repo to start.'))
    console.log('')
  })

// ── config command ──
program
  .command('config')
  .description('Show current configuration')
  .action(() => {
    printBanner()
    const config = loadConfig()
    console.log(chalk.bold('  Current configuration:'))
    console.log('')

    const rows: [string, string][] = [
      ['Provider', chalk.hex('#6c63ff')(config.provider)],
      ['Model', chalk.white(config.model)],
      ['API Key', config.apiKey ? chalk.green('✓ Set') : chalk.red('✗ Not set')],
      ['Ollama URL', chalk.gray(config.ollamaUrl)],
      ['Include body', config.includeBody ? chalk.green('yes') : chalk.gray('no')],
      ['Emoji style', chalk.gray(config.emojiStyle)],
      ['Max diff', chalk.gray(`${config.maxDiffLength} chars`)],
      ['Config file', chalk.gray(CONFIG_PATH)],
    ]

    rows.forEach(([k, v]) => {
      console.log(`  ${chalk.gray(k.padEnd(14))} ${v}`)
    })
    console.log('')
  })

// ── models command ──
program
  .command('models')
  .description('List recommended models per provider')
  .action(() => {
    printBanner()
    console.log(chalk.bold('  Recommended models:'))
    console.log('')

    const models = {
      OpenAI: [
        ['gpt-4o-mini', 'Fast, cheap, great quality — recommended default'],
        ['gpt-4o', 'Best quality, higher cost'],
        ['gpt-3.5-turbo', 'Very cheap, decent for simple commits'],
      ],
      Anthropic: [
        ['claude-3-haiku-20240307', 'Fast and affordable'],
        ['claude-3-5-sonnet-20241022', 'Best quality Claude model'],
      ],
      'Ollama (local, free)': [
        ['llama3.2', 'Recommended — good balance'],
        ['mistral', 'Good for code'],
        ['codellama', 'Code-specialized'],
        ['deepseek-coder-v2', 'Excellent for code commits'],
        ['qwen2.5-coder', 'Strong code model'],
      ],
    }

    for (const [provider, list] of Object.entries(models)) {
      console.log(chalk.bold.hex('#6c63ff')(`  ${provider}`))
      list.forEach(([model, desc]) => {
        console.log(`  ${chalk.white(model.padEnd(32))} ${chalk.gray(desc)}`)
      })
      console.log('')
    }
  })

program.parse()
