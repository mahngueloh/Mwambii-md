'use strict'

const fs   = require('fs')
const path = require('path')
const axios = require('axios')
const { execSync } = require('child_process')
const config = require('../config')

const ROOT     = path.join(__dirname, '..')
const BACKUP_DIR = path.join(ROOT, 'data', 'repair-backups')

// Every plugin/handler file that might contain a command worth repairing.
// (Deliberately excludes config.js, package.json, .env, index.js's
// connection logic — those aren't "commands" and a bad auto-edit there
// could take the whole bot offline in a way `.repair` can't recover from.)
function candidateFiles() {
    const files = [path.join(ROOT, 'handler.js')]
    const pluginsDir = path.join(ROOT, 'plugins')
    for (const f of fs.readdirSync(pluginsDir)) {
        if (f.endsWith('.js')) files.push(path.join(pluginsDir, f))
    }
    return files
}

// Finds `case 'cmdName':` (possibly chained with other case labels on the
// same line, e.g. `case 'vv': case 'reveal': {`) and extracts the full
// braced block that follows it, using brace-depth counting rather than
// "next case" — several blocks in this codebase contain their own nested
// braces (if/for/try), so a naive line-scan would grab the wrong amount.
function findCommandBlock(source, cmdName) {
    const caseRegex = new RegExp(`case\\s+'${cmdName}'\\s*:`)
    const match = caseRegex.exec(source)
    if (!match) return null

    // Walk backward to the start of the line so we capture any chained
    // `case 'x': case 'y':` labels on the same line as our match.
    let lineStart = source.lastIndexOf('\n', match.index) + 1

    const braceOpen = source.indexOf('{', match.index)
    if (braceOpen === -1) return null

    let depth = 0
    let i = braceOpen
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') {
            depth--
            if (depth === 0) { i++; break }
        }
    }
    if (depth !== 0) return null // unbalanced — bail rather than guess

    return {
        start: lineStart,
        end: i,
        text: source.slice(lineStart, i),
    }
}

function friendlyAiError(e, provider) {
    const status = e.response?.status
    if (status === 429) {
        return new Error(`${provider} rate-limit/quota hit (429) — free-tier limits are usually per-minute; wait a bit and try again, or switch to the other AI key if you have one.`)
    }
    if (status === 401 || status === 403) {
        return new Error(`${provider} rejected the API key (${status}) — check it's correct and active in .env.`)
    }
    return new Error(`${provider} request failed — ${e.message}`)
}

async function callGemini(prompt) {
    try {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${config.geminiApiKey}`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { timeout: 45_000 }
        )
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    } catch (e) {
        throw friendlyAiError(e, 'Gemini')
    }
}

async function callOpenAI(prompt) {
    try {
        const res = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0,
            },
            { headers: { Authorization: `Bearer ${config.openaiApiKey}` }, timeout: 45_000 }
        )
        return res.data?.choices?.[0]?.message?.content || ''
    } catch (e) {
        throw friendlyAiError(e, 'OpenAI')
    }
}

function stripCodeFence(text) {
    return text.replace(/^```[\w]*\n?/, '').replace(/```\s*$/, '').trim()
}

async function askAiForFix(cmdName, bugDescription, code) {
    const prompt = [
        `You are fixing one command handler inside a Node.js WhatsApp bot (Baileys library).`,
        `Command: "${cmdName}"`,
        `Reported bug: ${bugDescription}`,
        ``,
        `Here is the exact current code block for this command:`,
        '```javascript',
        code,
        '```',
        ``,
        `Return ONLY the corrected code block as plain code — no markdown fences, no explanation, `,
        `no commentary. Preserve the exact same case label(s), overall structure, and surrounding `,
        `style. Only change what's needed to fix the reported bug.`,
    ].join('\n')

    const attempts = []
    if (config.geminiApiKey) attempts.push(() => callGemini(prompt))
    if (config.openaiApiKey) attempts.push(() => callOpenAI(prompt))
    if (!attempts.length) throw new Error('No AI key configured — set OPENAI_API_KEY or GEMINI_API_KEY in .env to use .repair')

    let lastErr
    for (const attempt of attempts) {
        try { return stripCodeFence(await attempt()) }
        catch (e) { lastErr = e }
    }
    throw lastErr
}

function backupFile(filePath) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = path.join(BACKUP_DIR, `${path.basename(filePath)}.${stamp}.bak`)
    fs.copyFileSync(filePath, backupPath)
    return backupPath
}

function validateSyntax(filePath) {
    try {
        execSync(`node --check "${filePath}"`, { stdio: 'pipe' })
        return { ok: true }
    } catch (e) {
        return { ok: false, error: (e.stderr || e.message || '').toString().slice(0, 500) }
    }
}

async function repairCommand(cmdName, bugDescription) {
    for (const filePath of candidateFiles()) {
        const source = fs.readFileSync(filePath, 'utf8')
        const block = findCommandBlock(source, cmdName)
        if (!block) continue

        const fixedBlock = await askAiForFix(cmdName, bugDescription, block.text)
        if (!fixedBlock || fixedBlock.length < 10) {
            throw new Error('AI returned an empty/invalid fix — nothing was changed.')
        }

        const backupPath = backupFile(filePath)
        const newSource = source.slice(0, block.start) + fixedBlock + source.slice(block.end)
        fs.writeFileSync(filePath, newSource, 'utf8')

        const check = validateSyntax(filePath)
        if (!check.ok) {
            // Roll back immediately — never leave a file in a broken state.
            fs.copyFileSync(backupPath, filePath)
            return {
                success: false,
                file: path.relative(ROOT, filePath),
                error: check.error,
                rolledBack: true,
            }
        }

        return {
            success: true,
            file: path.relative(ROOT, filePath),
            backupPath: path.relative(ROOT, backupPath),
            oldCode: block.text,
            newCode: fixedBlock,
        }
    }
    return { success: false, notFound: true }
}

module.exports = { repairCommand }
