// api/analyze.js
// Reemplaza el proxy dumb por un endpoint inteligente con PubMed + imágenes de posts

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET')
  res.setHeader('Access-Control-Allow-Headers', '*')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { mode, prompt, posts } = req.body

    // ── MODO 1: proxy legacy (compatibilidad con frontend actual) ──────────────
    if (mode === 'legacy' || (!mode && prompt && !posts)) {
      const r = await callClaude([{ role: 'user', content: prompt }], 1500)
      return res.status(200).json(r)
    }

    // ── MODO 2: pipeline completo con posts estructurados ──────────────────────
    if (mode === 'full' && posts && Array.isArray(posts)) {
      const result = await runFullPipeline(posts)
      return res.status(200).json(result)
    }

    // ── MODO 3: solo PubMed (para llamadas individuales) ──────────────────────
    if (mode === 'pubmed') {
      const { claim } = req.body
      const papers = await searchPubMed(claim)
      return res.status(200).json({ papers })
    }

    return res.status(400).json({ error: 'Parámetros inválidos. Usa mode: legacy | full | pubmed' })

  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: e.message })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PIPELINE COMPLETO
// ─────────────────────────────────────────────────────────────────────────────

async function runFullPipeline(posts) {
  // 1. Extraer claims con referencia al post origen
  const claims = await extractClaimsWithSource(posts)

  // 2. Para cada claim: buscar papers en PubMed y evaluar
  const evaluatedClaims = await Promise.all(
    claims.map(async (claim) => {
      const papers = await searchPubMed(claim.text)
      const evaluation = await evaluateClaim(claim.text, papers)
      return {
        ...claim,
        ...evaluation,
        papers,
        // Imagen y URL del post origen
        post_image_url: posts[claim.source_post_index]?.image_url || null,
        post_url: posts[claim.source_post_index]?.url || null,
        post_date: posts[claim.source_post_index]?.date || null,
      }
    })
  )

  // 3. Score final del creador
  const creatorScore = calculateCreatorScore(evaluatedClaims)

  return {
    score: creatorScore.score,
    grade: creatorScore.grade,
    verdict: creatorScore.verdict,
    summary: creatorScore.summary,
    claims: evaluatedClaims,
    total_posts_analyzed: posts.length,
    total_claims: evaluatedClaims.length,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 1: EXTRACCIÓN DE CLAIMS CON REFERENCIA AL POST
// ─────────────────────────────────────────────────────────────────────────────

async function extractClaimsWithSource(posts) {
  // Formato: [POST_0] caption text\n---\n[POST_1] caption text
  const postsFormatted = posts
    .map((p, i) => `[POST_${i}]\n${p.text || p.caption || ''}`)
    .join('\n---\n')

  const systemPrompt = `Eres un extractor de afirmaciones científicas de contenido fitness/nutrición en Instagram.

Analiza los posts y extrae SOLO afirmaciones que sean verificables contra evidencia científica.
Ignora: motivación genérica, testimonios, frases de estilo de vida sin sustancia científica.

Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin backticks:
{
  "claims": [
    {
      "text": "afirmación concreta y verificable",
      "source_post_index": 0,
      "category": "nutrition|training|recovery|supplementation|general",
      "original_quote": "frase exacta del post que origina este claim"
    }
  ]
}

Máximo 10 claims. Prioriza los más específicos y verificables.`

  const response = await callClaude(
    [{ role: 'user', content: postsFormatted }],
    1200,
    systemPrompt
  )

  const text = response.content[0].text.trim()
  const parsed = safeParseJSON(text)
  return parsed?.claims || []
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 2: BÚSQUEDA EN PUBMED
// ─────────────────────────────────────────────────────────────────────────────

async function searchPubMed(claimText, maxResults = 5) {
  try {
    // Simplificar el claim para mejor búsqueda
    const searchTerm = await simplifyClaimForSearch(claimText)

    // Búsqueda de IDs
    const searchUrl =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?` +
      `db=pubmed&term=${encodeURIComponent(searchTerm)}&retmax=${maxResults}&retmode=json&sort=relevance`

    const searchRes = await fetch(searchUrl)
    const searchData = await searchRes.json()
    const ids = searchData.esearchresult?.idlist || []

    if (!ids.length) return []

    // Obtener metadata (títulos, autores, año)
    const summaryUrl =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?` +
      `db=pubmed&id=${ids.join(',')}&retmode=json`

    const summaryRes = await fetch(summaryUrl)
    const summaryData = await summaryRes.json()

    return ids
      .filter((id) => summaryData.result?.[id])
      .map((id) => {
        const paper = summaryData.result[id]
        const year = paper.pubdate?.split(' ')[0] || paper.epubdate?.split(' ')[0] || 'n/d'
        const authors = paper.authors?.slice(0, 3).map((a) => a.name).join(', ') || 'Unknown'
        return {
          pmid: id,
          title: paper.title || 'Sin título',
          authors,
          year,
          journal: paper.fulljournalname || paper.source || '',
          url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
          citation: `${authors} (${year}). ${paper.title}`,
        }
      })
  } catch (err) {
    console.error('PubMed error:', err)
    return []
  }
}

// Simplifica el claim a términos de búsqueda para PubMed
async function simplifyClaimForSearch(claimText) {
  const r = await callClaude(
    [
      {
        role: 'user',
        content: `Convierte este claim en 3-5 palabras clave en inglés para buscar en PubMed. Solo responde las palabras, nada más:\n\n"${claimText}"`,
      },
    ],
    100
  )
  return r.content[0].text.trim().replace(/['"]/g, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// PASO 3: EVALUACIÓN DE CLAIM VS PAPERS
// ─────────────────────────────────────────────────────────────────────────────

async function evaluateClaim(claimText, papers) {
  const paperContext =
    papers.length > 0
      ? papers
          .map((p) => `PMID ${p.pmid} (${p.year}) - ${p.authors}\nTítulo: ${p.title}\nJournal: ${p.journal}`)
          .join('\n\n')
      : 'No se encontraron papers relevantes en PubMed.'

  const systemPrompt = `Eres un evaluador científico de claims de fitness y nutrición.
Evalúa la afirmación contra la evidencia disponible y responde SOLO con JSON válido:
{
  "score": <número 0-10>,
  "verdict": "<WELL_SUPPORTED|PARTIALLY_SUPPORTED|UNSUPPORTED|MISLEADING|INSUFFICIENT_EVIDENCE>",
  "reasoning": "<explicación en español, máximo 3 oraciones>",
  "red_flag": <true|false>,
  "cited_pmids": ["<pmid1>", "<pmid2>"]
}`

  const userContent = `AFIRMACIÓN: "${claimText}"\n\nEVIDENCIA PUBMED:\n${paperContext}`

  const r = await callClaude([{ role: 'user', content: userContent }], 600, systemPrompt)
  const parsed = safeParseJSON(r.content[0].text.trim())

  return {
    score: parsed?.score ?? 5,
    verdict: parsed?.verdict ?? 'INSUFFICIENT_EVIDENCE',
    reasoning: parsed?.reasoning ?? 'No se pudo evaluar.',
    red_flag: parsed?.red_flag ?? false,
    cited_pmids: parsed?.cited_pmids ?? [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE FINAL DEL CREADOR
// ─────────────────────────────────────────────────────────────────────────────

function calculateCreatorScore(claims) {
  if (!claims.length) return { score: 0, grade: 'N/A', verdict: 'SIN_DATOS', summary: '' }

  const verdictWeights = {
    WELL_SUPPORTED: 100,
    PARTIALLY_SUPPORTED: 65,
    INSUFFICIENT_EVIDENCE: 40,
    UNSUPPORTED: 15,
    MISLEADING: 0,
  }

  const avgScore =
    claims.reduce((sum, c) => sum + (verdictWeights[c.verdict] ?? 40), 0) / claims.length

  const redFlags = claims.filter((c) => c.red_flag).length

  // Penalización por red flags
  const finalScore = Math.max(0, avgScore - redFlags * 8)
  const normalized = Math.round(finalScore / 10) / 10

  const grade =
    finalScore >= 85 ? 'A+' :
    finalScore >= 75 ? 'A-' :
    finalScore >= 65 ? 'B+' :
    finalScore >= 55 ? 'B-' :
    finalScore >= 40 ? 'C'  : 'D'

  const verdict =
    finalScore >= 75 ? 'RELIABLE_SOURCE' :
    finalScore >= 50 ? 'USE_WITH_CAUTION' : 'NOT_RECOMMENDED'

  return { score: normalized, grade, verdict, red_flags: redFlags }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function callClaude(messages, maxTokens = 1000, systemPrompt = null) {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages,
  }
  if (systemPrompt) body.system = systemPrompt

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })
  return r.json()
}

function safeParseJSON(text) {
  try {
    // Limpiar backticks si Claude los incluye
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return null
  }
}
