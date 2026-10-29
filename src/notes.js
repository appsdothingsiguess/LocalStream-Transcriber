import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const DEBUG = process.env.LOCALSTREAM_DEBUG === '1';
function dbg(msg) { if (DEBUG) console.log(`[DBG] ${msg}`); }

const NOTE_PROMPT_TEMPLATE = (transcript, pageTitle, pageUrl) => `You are turning a lecture/training transcript into study notes for Obsidian.

Output ONLY the Markdown note, starting with YAML frontmatter, nothing else (no preamble, no code fences).

Format:
---
title: "${pageTitle}"
source_url: "${pageUrl}"
date: ${new Date().toISOString().slice(0, 10)}
---

# ${pageTitle}

Then structured notes: headers for major topics, bullet points for key facts, bold for terms that matter. Be concise — this is a study aid, not a full re-transcription.

Transcript:
${transcript}`;

function sanitizeFilename(name) {
  return String(name || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

async function pickReachableHost(hosts) {
  for (const host of hosts) {
    try {
      const res = await fetch(`${host}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return host;
    } catch (_) {
      // try next host
    }
  }
  return null;
}

/**
 * Generate structured Markdown notes from a transcript via a local OpenAI-compatible
 * LLM endpoint (llama-swap → llama-server). Two-stage design: the model only emits
 * text — this file, not the model, decides where/how to write the file.
 */
export async function generateNote({ transcript, pageTitle, pageUrl, ollamaHosts, ollamaModel }) {
  const host = await pickReachableHost(ollamaHosts);
  if (!host) {
    throw new Error(`No reachable LLM host among: ${ollamaHosts.join(', ')}`);
  }

  dbg(`Generating notes via ${host} (model: ${ollamaModel})`);

  const res = await fetch(`${host}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: 'user', content: NOTE_PROMPT_TEMPLATE(transcript, pageTitle || 'Untitled', pageUrl || 'unknown') }],
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM request failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }

  const data = await res.json();
  const markdown = (data.choices?.[0]?.message?.content || '').trim();
  if (!markdown) {
    throw new Error('LLM returned an empty response.');
  }
  return markdown;
}

/**
 * Write generated Markdown into the Obsidian vault. Filename is date-prefixed
 * so multiple training modules on the same day don't collide alphabetically.
 */
export function saveNoteToVault(markdown, { pageTitle, jobId }, vaultPath) {
  if (!existsSync(vaultPath)) {
    mkdirSync(vaultPath, { recursive: true });
  }

  const datePrefix = new Date().toISOString().slice(0, 10);
  const titlePart = sanitizeFilename(pageTitle && pageTitle !== 'unknown' ? pageTitle : jobId);
  const notePath = path.join(vaultPath, `${datePrefix} - ${titlePart}.md`);

  writeFileSync(notePath, markdown, 'utf8');
  console.log(`📝  Notes saved → ${notePath}`);
  return notePath;
}
