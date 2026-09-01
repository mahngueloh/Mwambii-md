const config = require('../config')
const fmt    = require('../lib/format')

const historyMap = new Map()
const MAX_HISTORY = 8

const SYSTEM = (name, owner) =>
    `You are ${name}, a smart, friendly WhatsApp AI assistant created by ${owner}. ` +
    `Be helpful, concise and conversational. Keep replies under 200 words unless the user asks for more detail.`

async function aiReply(sock, from, text, msg) {
    // Show typing + processing reaction
    try { await sock.sendPresenceUpdate('composing', from) } catch {}
    await fmt.react(sock, msg, '🤖')

    if (config.openaiApiKey) return callOpenAI(sock, from, text, msg)
    if (config.geminiApiKey && !config.geminiApiKey.startsWith('PASTE_')) return callGemini(sock, from, text, msg)
    return noAiConfigured(sock, from, msg)
}

function formatAIResponse(reply) {
    // Split long replies into readable chunks (max 1500 chars per chunk)
    const lines = reply.split('\n')
    const chunks = []
    let current = ''
    for (const line of lines) {
        if ((current + '\n' + line).length > 1400) {
            chunks.push(current.trim())
            current = line
        } else {
            current += (current ? '\n' : '') + line
        }
    }
    if (current) chunks.push(current.trim())
    return chunks
}

async function sendAIResponse(sock, from, reply, msg, source = '') {
    const chunks = formatAIResponse(reply)
    const label  = source ? `🤖 *${config.botName} AI* ${source}` : `🤖 *${config.botName} AI*`

    // First chunk includes the header box
    await sock.sendMessage(from, {
        text: fmt.box(label, [chunks[0]])
    }, { quoted: msg })

    // Additional chunks (if reply was long) sent as plain continuations
    for (let i = 1; i < chunks.length; i++) {
        await sock.sendMessage(from, { text: chunks[i] })
    }
}

async function callOpenAI(sock, from, text, msg) {
    const hist = getHistory(from)
    hist.push({ role: 'user', content: text })
    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.openaiApiKey}` },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'system', content: SYSTEM(config.botName, config.ownerName) }, ...hist],
                max_tokens: 600
            }),
            signal: AbortSignal.timeout(25000)
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error.message)
        const reply = data.choices[0].message.content.trim()
        addToHistory(from, text, reply)
        return sendAIResponse(sock, from, reply, msg, '(GPT)')
    } catch (e) {
        console.error('OpenAI:', e.message)
        return noAiConfigured(sock, from, msg)
    }
}

async function callGemini(sock, from, text, msg) {
    const hist = getHistory(from)
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${config.geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM(config.botName, config.ownerName) }] },
                contents: [
                    ...hist.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
                    { role: 'user', parts: [{ text }] }
                ],
                generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
            }),
            signal: AbortSignal.timeout(25000)
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error.message)
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        if (!reply) throw new Error('Empty Gemini response')
        addToHistory(from, text, reply)
        return sendAIResponse(sock, from, reply, msg, '(Gemini)')
    } catch (e) {
        console.error('Gemini:', e.message)
        return noAiConfigured(sock, from, msg)
    }
}

// Pollinations (the previous no-key-required fallback) switched to a paid
// credit system and now returns 402 on almost every call — removed rather
// than kept around as dead weight. AI now runs on a bundled Gemini key
// (config.geminiApiKey, same pattern as the shared sports.js token) so this
// message should only ever show if that key hasn't been set yet.
function noAiConfigured(sock, from, msg) {
    return sock.sendMessage(from, {
        text: fmt.box('AI TEMPORARILY UNAVAILABLE', [
            `❌ AI replies aren't set up on this bot yet.`,
            `Contact ${config.ownerName} to get this enabled.`,
        ])
    }, { quoted: msg })
}

function getHistory(from) { return historyMap.get(from) || [] }
function addToHistory(from, userMsg, botMsg) {
    const hist = getHistory(from)
    hist.push({ role: 'user', content: userMsg }, { role: 'assistant', content: botMsg })
    if (hist.length > MAX_HISTORY * 2) hist.splice(0, 2)
    historyMap.set(from, hist)
}

module.exports = { aiReply }
