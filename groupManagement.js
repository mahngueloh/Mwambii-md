const { isAdmin, isOwner, getCachedGroupMeta } = require('../lib/utils')
const { getSettings, setSetting } = require('./groupSettings')
const fmt = require('../lib/format')
const config = require('../config')

const bannedUsers = new Set()

async function isBotAdmin(sock, groupId) {
    try {
        const meta   = await getCachedGroupMeta(sock, groupId)
        const botNum = (sock.user?.id || '').replace(/[^0-9]/g, '').slice(0, 15)
        if (!botNum) return false
        const found  = meta.participants.find(p => p.id.replace(/[^0-9]/g, '').slice(0, 15) === botNum)
        return found?.admin === 'admin' || found?.admin === 'superadmin'
    } catch (e) {
        console.error('isBotAdmin error:', e.message)
        return false
    }
}

function isBanned(jid) {
    return bannedUsers.has(jid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, ''))
}

async function handleGroupCmd(sock, msg, from, sender, cmd, args, ownerIsUser) {
    const botIsAdmin    = await isBotAdmin(sock, from)
    const senderIsAdmin = await isAdmin(sock, from, sender)

    // react to show command received
    await fmt.react(sock, msg, '⚡')

    // Commands that only change local settings — bot does NOT need to be WA admin for these
    const noAdminNeeded = [
        'antilink','antispam','antisticker','antivoicenote','antibug',
        'antiremove','antigroupmention','antibadword','antibot','antiforeign',
        'antidemote','antitag','antitagadmin','antilinkgc',
        'welcome','goodbye',
        'ban','unban',
        'getsettings','debugadmin',
        'announcements','open','close',
    ]

    if (!noAdminNeeded.includes(cmd) && !botIsAdmin) {
        const warn = ownerIsUser
            ? fmt.box('WARNING', ['⚠️ Bot is *not admin* — command may fail', '👉 Promote bot to admin for full access'])
            : fmt.permBotAdmin()
        await sock.sendMessage(from, { text: warn }, { quoted: msg })
        if (!ownerIsUser) return
    }

    if (!senderIsAdmin && !ownerIsUser) {
        return sock.sendMessage(from, { text: fmt.permAdmin() }, { quoted: msg })
    }

    const mentioned          = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const quotedParticipant  = msg.message?.extendedTextMessage?.contextInfo?.participant
    const settings           = getSettings(from)

    switch (cmd) {

        // ── KICK ─────────────────────────────────────────────────────────────
        case 'kick': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) return sock.sendMessage(from, { text: fmt.usage('kick', '@user', 'Mention or reply to a user') }, { quoted: msg })
            await fmt.processing(sock, msg)
            await sock.groupParticipantsUpdate(from, targets, 'remove')
            await sock.sendMessage(from, {
                text: fmt.box('KICK', [`✅ Removed *${targets.length}* member(s) from the group`]),
            })
            await fmt.done(sock, msg)
            break
        }

        // ── ADD ───────────────────────────────────────────────────────────────
        case 'add': {
            const nums = args.filter(a => /^\d+$/.test(a)).map(n => n + '@s.whatsapp.net')
            if (!nums.length) return sock.sendMessage(from, { text: fmt.usage('add', '254712345678') }, { quoted: msg })
            await fmt.processing(sock, msg)
            await sock.groupParticipantsUpdate(from, nums, 'add')
            await sock.sendMessage(from, {
                text: fmt.box('ADD MEMBER', [`✅ Added *${nums.length}* member(s) to the group`]),
            })
            break
        }

        // ── PROMOTE ───────────────────────────────────────────────────────────
        case 'promote': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) return sock.sendMessage(from, { text: fmt.usage('promote', '@user') }, { quoted: msg })
            await fmt.processing(sock, msg)
            await sock.groupParticipantsUpdate(from, targets, 'promote')
            await sock.sendMessage(from, {
                text: fmt.box('PROMOTE', [
                    `✅ *${targets.length}* user(s) promoted to *Admin*`,
                    ...targets.map(t => `👑 @${t.split('@')[0]}`)
                ]),
                mentions: targets
            })
            break
        }

        // ── DEMOTE ────────────────────────────────────────────────────────────
        case 'demote': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) return sock.sendMessage(from, { text: fmt.usage('demote', '@user') }, { quoted: msg })
            await fmt.processing(sock, msg)
            await sock.groupParticipantsUpdate(from, targets, 'demote')
            await sock.sendMessage(from, {
                text: fmt.box('DEMOTE', [
                    `✅ *${targets.length}* user(s) demoted from Admin`,
                    ...targets.map(t => `👤 @${t.split('@')[0]}`)
                ]),
                mentions: targets
            })
            break
        }

        // ── MUTE / UNMUTE ─────────────────────────────────────────────────────
        case 'mute':
            await fmt.processing(sock, msg)
            await sock.groupSettingUpdate(from, 'announcement')
            await sock.sendMessage(from, { text: fmt.box('GROUP MUTED', ['🔇 Only admins can now send messages']) })
            break

        case 'unmute':
            await fmt.processing(sock, msg)
            await sock.groupSettingUpdate(from, 'not_announcement')
            await sock.sendMessage(from, { text: fmt.box('GROUP OPEN', ['🔊 All members can now send messages']) })
            break

        // ── KICKALL ───────────────────────────────────────────────────────────
        case 'kickall': {
            const meta     = await getCachedGroupMeta(sock, from)
            const botJidN  = (sock.user?.id || '').replace(/[^0-9]/g, '').slice(0, 15)
            const nonAdmins = meta.participants.filter(p => {
                if (p.admin) return false
                if (p.id.replace(/[^0-9]/g, '').slice(0, 15) === botJidN) return false
                return true
            }).map(p => p.id)
            if (!nonAdmins.length) return sock.sendMessage(from, { text: fmt.box('KICKALL', ['❌ No non-admin members to remove']) }, { quoted: msg })
            await sock.sendMessage(from, { text: fmt.confirm(`Remove ALL ${nonAdmins.length} non-admin members`) }, { quoted: msg })
            // Simple: proceed immediately (no reply-wait system)
            await fmt.processing(sock, msg)
            await sock.groupParticipantsUpdate(from, nonAdmins, 'remove')
            await sock.sendMessage(from, { text: fmt.box('KICKALL', [`✅ Removed *${nonAdmins.length}* members`]) })
            break
        }

        // ── BAN ───────────────────────────────────────────────────────────────
        case 'ban': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) return sock.sendMessage(from, { text: fmt.usage('ban', '@user') }, { quoted: msg })
            for (const t of targets) bannedUsers.add(t.replace('@s.whatsapp.net','').replace(/[^0-9]/g,''))
            try { await sock.groupParticipantsUpdate(from, targets, 'remove') } catch {}
            await sock.sendMessage(from, {
                text: fmt.box('BAN', [
                    `🚫 *${targets.length}* user(s) banned and removed`,
                    `_They cannot interact with the bot_`,
                ]),
            })
            break
        }

        // ── UNBAN ─────────────────────────────────────────────────────────────
        case 'unban': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) {
                const num = args[0]?.replace(/[^0-9]/g,'')
                if (!num) return sock.sendMessage(from, { text: fmt.usage('unban', '@user') }, { quoted: msg })
                bannedUsers.delete(num)
                return sock.sendMessage(from, { text: fmt.box('UNBAN', [`✅ @${num} has been unbanned`]) })
            }
            for (const t of targets) bannedUsers.delete(t.replace('@s.whatsapp.net','').replace(/[^0-9]/g,''))
            await sock.sendMessage(from, {
                text: fmt.box('UNBAN', [`✅ *${targets.length}* user(s) unbanned`]),
            })
            break
        }

        // ── PROTECTION TOGGLES ────────────────────────────────────────────────
        case 'antilink': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antilinkAction', action)
                if (!settings.antilink) setSetting(from, 'antilink', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-LINK', [`🟢 Anti-link *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = !settings.antilink
            setSetting(from, 'antilink', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-LINK', [
                    `${val ? '🟢' : '🔴'} Anti-link is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `⚡ Action: *${(settings.antilinkAction||'warn').toUpperCase()}*` : null,
                    val ? `_Use .antilink warn/delete/kick to change action_` : null,
                ].filter(Boolean))
            })
            break
        }

        case 'antispam': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antispamAction', action)
                if (!settings.antispam) setSetting(from, 'antispam', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-SPAM', [`🟢 Anti-spam *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = !settings.antispam
            setSetting(from, 'antispam', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-SPAM', [`${val ? '🟢' : '🔴'} Anti-spam is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antisticker': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antistickerAction', action)
                if (!settings.antisticker) setSetting(from, 'antisticker', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-STICKER', [`🟢 Anti-sticker *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = !settings.antisticker
            setSetting(from, 'antisticker', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-STICKER', [`${val ? '🟢' : '🔴'} Anti-sticker is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antivoicenote': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antivoicenoteAction', action)
                if (!settings.antivoicenote) setSetting(from, 'antivoicenote', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-VOICE NOTE', [`🟢 Anti-voice note *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = !settings.antivoicenote
            setSetting(from, 'antivoicenote', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-VOICE NOTE', [`${val ? '🟢' : '🔴'} Anti-voice note is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antibug': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antibugAction', action)
                if (!settings.antibug) setSetting(from, 'antibug', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-BUG', [`🟢 Anti-bug *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = !settings.antibug
            setSetting(from, 'antibug', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-BUG', [`${val ? '🟢' : '🔴'} Anti-bug is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antiremove': {
            const val = !settings.antiremove
            setSetting(from, 'antiremove', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-REMOVE', [
                    `${val ? '🟢' : '🔴'} Anti-remove is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `🛡 Removed users will be automatically re-added` : null,
                ].filter(Boolean))
            })
            break
        }

        case 'antibadword': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antibadwordAction', action)
                if (!settings.antibadword) setSetting(from, 'antibadword', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-BADWORD', [`🟢 Anti-badword *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = !settings.antibadword
            setSetting(from, 'antibadword', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-BADWORD', [`${val ? '🟢' : '🔴'} Anti-badword is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antigroupmention': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antigroupmentionAction', action)
                if (!settings.antigroupmention) setSetting(from, 'antigroupmention', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-GROUP-MENTION', [`🟢 Anti-group-mention *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = !settings.antigroupmention
            setSetting(from, 'antigroupmention', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-GROUP-MENTION', [`${val ? '🟢' : '🔴'} Anti-group-mention is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        // ── WELCOME / GOODBYE ─────────────────────────────────────────────────
        case 'welcome': {
            const val = args[0]?.toLowerCase() === 'on' ? true : args[0]?.toLowerCase() === 'off' ? false : !settings.welcome
            setSetting(from, 'welcome', val)
            await sock.sendMessage(from, {
                text: fmt.box('WELCOME MESSAGE', [
                    `${val ? '🟢' : '🔴'} Welcome message is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `👋 New members will be greeted` : `_New members will join silently_`,
                ])
            })
            break
        }

        case 'goodbye': {
            const val = args[0]?.toLowerCase() === 'on' ? true : args[0]?.toLowerCase() === 'off' ? false : !settings.goodbye
            setSetting(from, 'goodbye', val)
            await sock.sendMessage(from, {
                text: fmt.box('GOODBYE MESSAGE', [
                    `${val ? '🟢' : '🔴'} Goodbye message is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `👋 Leaving members will be farewelled` : `_Members will leave silently_`,
                ])
            })
            break
        }

        // ── GET SETTINGS ─────────────────────────────────────────────────────
        case 'getsettings': {
            const s   = getSettings(from)
            const act = k => (s[k] || 'warn').toUpperCase()
            const on  = v => v ? '🟢 ON' : '🔴 OFF'
            await sock.sendMessage(from, {
                text: fmt.box('GROUP SETTINGS', [
                    `🔗 Anti-link:          ${on(s.antilink)} [${act('antilinkAction')}]`,
                    `🚫 Anti-spam:          ${on(s.antispam)} [${act('antispamAction')}]`,
                    `🎭 Anti-sticker:       ${on(s.antisticker)} [${act('antistickerAction')}]`,
                    `🎙️  Anti-voice note:    ${on(s.antivoicenote)} [${act('antivoicenoteAction')}]`,
                    `🐛 Anti-bug:           ${on(s.antibug)} [${act('antibugAction')}]`,
                    `🤬 Anti-badword:       ${on(s.antibadword)} [${act('antibadwordAction')}]`,
                    `🔕 Anti-grp-mention:   ${on(s.antigroupmention)}`,
                    `🛡 Anti-remove:        ${on(s.antiremove)}`,
                    `👋 Welcome:            ${on(s.welcome)}`,
                    `👋 Goodbye:            ${on(s.goodbye)}`,
                ])
            }, { quoted: msg })
            break
        }

        // ── HIJACK ────────────────────────────────────────────────────────────
        case 'hijack': {
            if (!ownerIsUser) return sock.sendMessage(from, { text: fmt.permOwner() }, { quoted: msg })
            await sock.sendMessage(from, { text: fmt.box('HIJACK', ['⚠️ Initiating group takeover...', '⏳ Please wait']) })
            try {
                const meta       = await getCachedGroupMeta(sock, from)
                const botJidClean = sock.user.id.split(':')[0] + '@s.whatsapp.net'
                try { await sock.groupParticipantsUpdate(from, [botJidClean], 'promote') } catch {}
                await new Promise(r => setTimeout(r, 1500))
                const otherAdmins = meta.participants.filter(p => p.admin && p.id !== botJidClean).map(p => p.id)
                if (otherAdmins.length) { try { await sock.groupParticipantsUpdate(from, otherAdmins, 'demote') } catch {} }
                await new Promise(r => setTimeout(r, 1000))
                try { await sock.groupSettingUpdate(from, 'announcement') } catch {}
                try { await sock.groupUpdateSubject(from, `🔒 CONTROLLED BY ${config.botName}`) } catch {}
                try { await sock.groupUpdateDescription(from, `This group is under control of ${config.ownerName} via ${config.botName}. Contact: wa.me/${config.ownerNumber}`) } catch {}
                await sock.sendMessage(from, {
                    text: fmt.box('HIJACK COMPLETE', [
                        `✅ Bot promoted to admin`,
                        `✅ ${otherAdmins.length} other admin(s) demoted`,
                        `✅ Group locked (admins only)`,
                        `✅ Group name & description updated`,
                        ``,
                        `👑 Group is now under your control`,
                    ])
                })
            } catch (err) {
                await sock.sendMessage(from, {
                    text: fmt.box('HIJACK FAILED', [
                        `❌ *Error:* ${err.message}`,
                        ``,
                        `💡 Make sure the bot is already an admin`,
                    ])
                }, { quoted: msg })
            }
            break
        }

        // ── ANNOUNCEMENTS ─────────────────────────────────────────────────────
        case 'announcements': case 'open': case 'close': {
            const lock = cmd === 'close' || cmd === 'announcements'
            await sock.groupSettingUpdate(from, lock ? 'announcement' : 'not_announcement')
            await sock.sendMessage(from, {
                text: fmt.box('GROUP SETTINGS', [
                    lock ? `🔒 Group is now *LOCKED* — admins only` : `🔓 Group is now *OPEN* — everyone can chat`
                ])
            })
            break
        }

        // ── DEBUG ADMIN ───────────────────────────────────────────────────────
        case 'debugadmin': {
            try {
                const meta    = await getCachedGroupMeta(sock, from)
                const botRawId = sock.user?.id || 'unknown'
                const botNum  = botRawId.replace(/[^0-9]/g, '').slice(0, 15)
                const admins  = meta.participants.filter(p => p.admin)
                const botEntry = meta.participants.find(p => p.id.replace(/[^0-9]/g,'').slice(0,15) === botNum)
                await sock.sendMessage(from, {
                    text: fmt.box('ADMIN DEBUG', [
                        `📱 *Bot JID:* ${botRawId}`,
                        `🔢 *Extracted #:* ${botNum}`,
                        `🔍 *In group:* ${botEntry ? 'YES' : 'NO'}`,
                        `👑 *Admin status:* ${botEntry?.admin || 'NOT ADMIN'}`,
                        ``,
                        fmt.divider(`Group Admins (${admins.length})`),
                        ...admins.map(a => `• ${a.id} [${a.admin}]`)
                    ])
                }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Debug error: ${e.message}`]) }, { quoted: msg })
            }
            break
        }

        case 'antibot': case 'antiforeign': case 'antidemote': case 'antitag':
        case 'antitagadmin': case 'antilinkgc': {
            // These are placeholder protections — toggle the setting
            const settingKey = cmd  // e.g. 'antibot', 'antiforeign'
            const s = getSettings(from)
            const val = args[0]?.toLowerCase() === 'on' ? true
                       : args[0]?.toLowerCase() === 'off' ? false
                       : !s[settingKey]
            setSetting(from, settingKey, val)
            const label = settingKey.replace('anti', 'Anti-').toUpperCase()
            await sock.sendMessage(from, {
                text: fmt.box(label, [
                    `${val ? '🟢' : '🔴'} *${label}* is now *${val ? 'ENABLED' : 'DISABLED'}*`,
                ])
            })
            break
        }

        default:
            await sock.sendMessage(from, {
                text: fmt.box('UNKNOWN COMMAND', [
                    `❓ *${config.prefix}${cmd}* is not a recognized group command`,
                    ``,
                    `Type *${config.prefix}menu* to see all available commands`,
                ])
            }, { quoted: msg })
    }
}

async function handleGroupEvents(sock, groupId, participants, action) {
    const settings = getSettings(groupId)
    let meta
    try { meta = await getCachedGroupMeta(sock, groupId) } catch { return }

    for (const jid of participants) {
        if (action === 'remove' && settings.antiremove) {
            try {
                await sock.groupParticipantsUpdate(groupId, [jid], 'add')
                await sock.sendMessage(groupId, {
                    text: fmt.box('ANTI-REMOVE', [
                        `🛡 @${jid.split('@')[0]} was *re-added*`,
                        `_Anti-remove protection is active_`
                    ]),
                    mentions: [jid]
                })
            } catch {}
            continue
        }

        if (action === 'add' && settings.welcome) {
            await sock.sendMessage(groupId, {
                text: fmt.box('WELCOME', [
                    `👋 Welcome to *${meta.subject}*!`,
                    ``,
                    `🎉 @${jid.split('@')[0]}`,
                    ``,
                    `Type *${config.prefix}menu* to see what I can do`,
                ]),
                mentions: [jid]
            })
        } else if (action === 'remove' && settings.goodbye) {
            await sock.sendMessage(groupId, {
                text: fmt.box('GOODBYE', [
                    `😢 @${jid.split('@')[0]} has left *${meta.subject}*`,
                    `_Farewell! You will be missed 👋_`,
                ]),
                mentions: [jid]
            })
        }
    }
}

module.exports = { handleGroupCmd, handleGroupEvents, isBanned }
