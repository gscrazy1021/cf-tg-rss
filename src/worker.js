// 定时触发器 + HTTP 触发器二合一
import channelsTxt from './channels.txt'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

async function fetchChannel(chan, beforeId) {
  const u = new URL(`https://t.me/s/${chan}`)
  if (beforeId) u.searchParams.set('before', beforeId)
  const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT } })
  if (!r.ok) throw new Error(`${chan} ${r.status}`)
  return r.text()
}

function parse(html, chan) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const msgs = []
  for (const div of doc.querySelectorAll('.tgme_widget_message')) {
    if (div.classList.contains('tgme_widget_message_sticker')) continue
    const pid = div.dataset.post.split('/').pop()
    const msgId = parseInt(pid, 10)
    const textDiv = div.querySelector('.tgme_widget_message_text')
    const text = textDiv ? textDiv.textContent.trim() : ''
    const mediaA = div.querySelector('a.tgme_widget_message_photo_wrap,a.tgme_widget_message_video_player')
    const mediaUrl = mediaA ? mediaA.href : null
    const timeTag = div.querySelector('time')
    const published = timeTag ? new Date(timeTag.dateTime).toISOString() : new Date().toISOString()
    const link = `https://t.me/${div.dataset.post}`
    msgs.push({ chan, msgId, text, published, mediaUrl, link })
  }
  return msgs.sort((a, b) => a.msgId - b.msgId)
}

async function crawlOne(chan, lastId) {
  const html = await fetchChannel(chan, lastId || null)
  const msgs = parse(html, chan).filter(m => m.msgId > (lastId || 0))
  if (msgs.length === 0) return []
  // 往前翻页，直到 50 条
  let oldest = msgs[0].msgId
  while (msgs.length < 50) {
    const h = await fetchChannel(chan, oldest)
    const batch = parse(h, chan).filter(m => m.msgId > (lastId || 0))
    if (batch.length === 0) break
    msgs.unshift(...batch)
    oldest = batch[0].msgId
  }
  return msgs
}

function buildRSS(msgs) {
  const now = new Date().toISOString()
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Telegram 多频道合并</title>
    <link>https://github.com/yourname/cf-tg-rss</link>
    <description>边缘合并 RSS</description>
    <language>zh-CN</language>
    <lastBuildDate>${now}</lastBuildDate>\n`
  for (const m of msgs) {
    const title = (m.text.slice(0, 60) + (m.text.length > 60 ? '…' : '')) || '无标题'
    const desc = m.text + (m.mediaUrl ? `<br><img src="${m.mediaUrl}">` : '')
    xml += `    <item>
      <title><![CDATA[${title}]]></title>
      <link>${m.link}</link>
      <guid isPermaLink="true">${m.link}</guid>
      <description><![CDATA[${desc}]]></description>
      <pubDate>${new Date(m.published).toUTCString()}</pubDate>
      <category>${m.chan}</category>
    </item>\n`
  }
  xml += '  </channel>\n</rss>'
  return xml
}

// 定时触发器（CRON）
export async function scheduled(event, env, ctx) {
  ctx.waitUntil(doCrawl(env))
}

// 手动/被外网触发
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    if (url.pathname === '/merged.xml') {
      const obj = await env.BUCKET.get('merged.xml')
      if (!obj) return new Response('Not found', { status: 404 })
      return new Response(obj.body, {
        headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' }
      })
    }
    if (url.pathname === '/update') {
      ctx.waitUntil(doCrawl(env))
      return new Response('Update scheduled', { status: 202 })
    }
    return new Response('OK')
  }
}

async function doCrawl(env) {
  const chanList = channelsTxt.trim().split(/\s*\n\s*/)
  const db = await env.BUCKET.get('db.json') // 简易 KV：存各频道最新 msgId
  let dbMap = db ? JSON.parse(await db.text()) : {}
  const allMsgs = []
  for (const ch of chanList) {
    try {
      const last = dbMap[ch] || 0
      const msgs = await crawlOne(ch, last)
      if (msgs.length) {
        dbMap[ch] = Math.max(...msgs.map(m => m.msgId))
        allMsgs.push(...msgs)
      }
    } catch (e) {
      console.error(e)
    }
  }
  if (allMsgs.length) {
    allMsgs.sort((a, b) => new Date(b.published) - new Date(a.published))
    const rss = buildRSS(allMsgs)
    await env.BUCKET.put('merged.xml', rss)
    await env.BUCKET.put('db.json', JSON.stringify(dbMap))
  }
}
