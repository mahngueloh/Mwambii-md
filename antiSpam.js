const { isAdmin } = require('../lib/utils')
const { getSettings } = require('./groupSettings')
const fmt = require('../lib/format')

const LINK_REGEX = /(?:https?:\/\/|www\.|chat\.whatsapp\.com|t\.me|bit\.ly|youtu\.be)\S+/i
const SPAM_LIMIT  = 5
const SPAM_WINDOW = 5000
const BUG_PATTERNS = [/[\u0600-\u06FF]{500,}/, /\u202E/, /(\u0000){5,}/, /[\uFE30-\uFE4F]{50,}/]

const warnCounts = new Map()
const WARN_MAX   = 3

// ── Generic action helper ─────────────────────────────────────────────────────
async function applyAction(sock, msg, from, sender, action, reason) {
    const key   = `${from}_${sender}`
    const warns = (warnCounts.get(key) || 0) + 1
    const userNum = sender.split('@')[0]

    // Always delete the offending message first
    try { await sock.sendMessage(from, { delete: msg.key }) } catch {}

    if (action === 'warn') {
        warnCounts.set(key, warns)
        const reachedMax = warns >= WARN_MAX
        if (reachedMax) {
            warnCounts.delete(key)
            try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        }
        await sock.sendMessage(from, {
            text: fmt.warnCard(userNum, warns, WARN_MAX, reason),
            mentions: [sender]
        })
    } else if (action === 'delete') {
        await sock.sendMessage(from, {
            text: fmt.box('MESSAGE DELETED', [
                `🗑️ @${userNum} — message removed`,
                `📌 *Reason:* ${reason}`,
            ]),
            mentions: [sender]
        })
    } else if (action === 'kick') {
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        await sock.sendMessage(from, {
            text: fmt.kickCard(userNum, reason),
            mentions: [sender]
        })
    }
}

// ── Anti-link ─────────────────────────────────────────────────────────────────
async function antiLinkCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antilink) return false
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || ''
    if (!LINK_REGEX.test(body)) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antilinkAction || 'warn', 'Links are not allowed in this group')
    return true
}

// ── Anti-spam ─────────────────────────────────────────────────────────────────
async function antiSpamCheck(sock, msg, from, sender, spamMap) {
    const s = getSettings(from)
    if (!s.antispam) return false
    if (await isAdmin(sock, from, sender)) return false
    const key   = `${from}_${sender}`
    const now   = Date.now()
    const entry = spamMap.get(key) || { count: 0, first: now }
    if (now - entry.first > SPAM_WINDOW) { spamMap.set(key, { count: 1, first: now }); return false }
    entry.count++
    spamMap.set(key, entry)
    if (entry.count >= SPAM_LIMIT) {
        spamMap.delete(key)
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        await sock.sendMessage(from, {
            text: fmt.kickCard(sender.split('@')[0], 'Spamming too many messages'),
            mentions: [sender]
        })
        return true
    }
    return false
}

// ── Anti-sticker ──────────────────────────────────────────────────────────────
async function antiStickerCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antisticker || !msg.message?.stickerMessage) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antistickerAction || 'delete', 'Stickers are not allowed here')
    return true
}

// ── Anti-voice note ───────────────────────────────────────────────────────────
async function antiVoiceNoteCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antivoicenote || msg.message?.audioMessage?.ptt !== true) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antivoicenoteAction || 'delete', 'Voice notes are not allowed here')
    return true
}

// ── Anti-bug ──────────────────────────────────────────────────────────────────
async function antiBugCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antibug) return false
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    if (!BUG_PATTERNS.some(p => p.test(body))) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antibugAction || 'kick', 'Crash/bug message detected')
    return true
}

// ── Anti-group-mention ────────────────────────────────────────────────────────
async function antiGroupMentionCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antigroupmention) return false
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    const hasGroupMention =
        /@(everyone|all|here|group)/i.test(body) ||
        (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length || 0) > 5
    if (!hasGroupMention) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antigroupmentionAction || 'delete', 'Mass group mentions are not allowed')
    return true
}

module.exports = { antiLinkCheck, antiSpamCheck, antiStickerCheck, antiVoiceNoteCheck, antiBugCheck, antiGroupMentionCheck }
