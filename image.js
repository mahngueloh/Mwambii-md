const fmt = require('../lib/format')

const silentLogger = {
    level: 'silent', child: () => silentLogger,
    info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {}
}

async function getWallpaper(sock, from, query, msg) {
    try {
        const q   = encodeURIComponent(query || 'nature wallpaper 4k')
        // Unsplash source — free, no key
        const url = `https://source.unsplash.com/1080x1920/?${q}&sig=${Date.now()}`
        await sock.sendMessage(from, {
            image: { url },
            caption: fmt.box('WALLPAPER', [
                `🖼️ *Query:* ${query || 'Random'}`,
                `_Powered by Unsplash_`,
            ])
        }, { quoted: msg })
    } catch {
        try {
            // Fallback: Lorem Picsum
            await sock.sendMessage(from, {
                image: { url: `https://picsum.photos/1080/1920?random=${Date.now()}` },
                caption: fmt.box('WALLPAPER', [`🖼️ Random wallpaper`])
            }, { quoted: msg })
        } catch {
            await sock.sendMessage(from, {
                text: fmt.box('WALLPAPER FAILED', [`❌ Could not fetch wallpaper. Try again.`])
            }, { quoted: msg })
        }
    }
}

async function getRemini(sock, from, msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (!quoted?.imageMessage) {
        return sock.sendMessage(from, {
            text: fmt.box('REMINI', [
                `❌ *Reply to an image* with *.remini* to enhance it`,
            ])
        }, { quoted: msg })
    }
    try {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys')
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {}
        const quotedKey = {
            remoteJid: from,
            id: ctx.stanzaId || '',
            participant: ctx.participant || '',
        }
        const buf = await downloadMediaMessage(
            { message: quoted, key: quotedKey },
            'buffer', {},
            { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
        )

        // DeepAI free tier
        const formData = new FormData()
        formData.append('image', new Blob([buf], { type: 'image/jpeg' }), 'image.jpg')

        const res = await fetch('https://api.deepai.org/api/torch-srgan', {
            method: 'POST',
            headers: { 'api-key': 'quickstart-QUdJIGlzIGNvbWluZy4uLi4K' },
            body: formData,
            signal: AbortSignal.timeout(30000)
        })
        const data = await res.json()
        if (data.output_url) {
            await sock.sendMessage(from, {
                image: { url: data.output_url },
                caption: fmt.box('REMINI', [`✅ Image enhanced successfully!`])
            }, { quoted: msg })
        } else {
            throw new Error('No result from API')
        }
    } catch (e) {
        await sock.sendMessage(from, {
            text: fmt.box('REMINI FAILED', [
                `❌ Enhancement failed`,
                ``,
                `💡 Try these free alternatives:`,
                `• https://remini.ai`,
                `• https://letsenhance.io`,
                `• https://picwish.com`,
            ])
        }, { quoted: msg })
    }
}

module.exports = { getWallpaper, getRemini }
