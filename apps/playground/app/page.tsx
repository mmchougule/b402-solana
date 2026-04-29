/**
 * b402-solana playground landing.
 *
 * Honest v0: this is the landing page that tells visitors what b402 is and
 * points them at `create-b402-agent` to try it locally. The hosted devnet
 * playground (server-side ephemeral keypairs + click-through shield/swap)
 * is in the roadmap section below — not built yet because it's a multi-day
 * project to do safely (circuit hosting, session isolation, rate-limiting).
 */

const sx = {
  page: {
    maxWidth: 720,
    margin: '0 auto',
    padding: '4rem 1.5rem',
    lineHeight: 1.6,
  } as const,
  hero: {
    fontSize: '2.5rem',
    fontWeight: 700,
    margin: 0,
    letterSpacing: '-0.02em',
  } as const,
  subhero: {
    fontSize: '1.25rem',
    opacity: 0.75,
    marginTop: '0.5rem',
    marginBottom: '2rem',
  } as const,
  cta: {
    display: 'inline-block',
    padding: '0.75rem 1rem',
    background: '#fff',
    color: '#0a0a0a',
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '0.9rem',
    borderRadius: 6,
    textDecoration: 'none',
    fontWeight: 500,
  } as const,
  section: { marginTop: '3rem' } as const,
  h2: {
    fontSize: '1.25rem',
    fontWeight: 600,
    margin: '0 0 0.75rem',
  } as const,
  code: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    padding: '0.75rem 1rem',
    borderRadius: 6,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '0.85rem',
    overflow: 'auto',
  } as const,
  ul: { paddingLeft: '1.25rem', margin: 0 } as const,
  link: { color: '#7aa2ff', textDecoration: 'none' } as const,
  badge: {
    display: 'inline-block',
    padding: '0.15rem 0.5rem',
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    fontSize: '0.75rem',
    opacity: 0.75,
    marginLeft: '0.5rem',
    verticalAlign: 'middle',
  } as const,
};

export default function Home() {
  return (
    <main style={sx.page}>
      <h1 style={sx.hero}>b402-solana</h1>
      <p style={sx.subhero}>
        Private DeFi on Solana. Shielded balances + composable adapters +
        agent-callable MCP.
      </p>

      <section style={sx.section}>
        <h2 style={sx.h2}>Try it in 60 seconds</h2>
        <pre style={sx.code}>
{`npx @b402ai/create-agent my-agent
cd my-agent
cp .env.example .env  # point B402_KEYPAIR_PATH at your Solana CLI keypair
pnpm install
pnpm dev`}
        </pre>
        <p style={{ opacity: 0.7, fontSize: '0.9rem' }}>
          Three real devnet transactions printed with Solana Explorer URLs on
          every run.
        </p>
      </section>

      <section style={sx.section}>
        <h2 style={sx.h2}>What an agent calls</h2>
        <pre style={sx.code}>
{`b402.shield({ mint, amount })          // SPL → private balance
b402.balance()                         // private balance per mint
b402.holdings()                        // per-deposit view
b402.watchIncoming({ cursor })         // poll for new arrivals
b402.quoteSwap({ inMint, outMint })    // Jupiter quote pre-execute
b402.privateSwap({ ... })              // atomic shield→swap→reshield
b402.unshield({ to })                  // private → public address`}
        </pre>
        <p style={{ opacity: 0.7, fontSize: '0.9rem' }}>
          Same surface exposed as MCP tools for Claude Code / Cursor agents.
        </p>
      </section>

      <section style={sx.section}>
        <h2 style={sx.h2}>Hosted playground <span style={sx.badge}>roadmap</span></h2>
        <p style={{ opacity: 0.85 }}>
          A click-through devnet flow (create session → shield → swap →
          unshield) lands here when session isolation, prover artifact
          hosting and rate-limiting are properly designed. Until then, the
          local <code style={{ background: '#1a1a1a', padding: '0.1rem 0.3rem', borderRadius: 3 }}>create-b402-agent</code> flow above is the real way to try it.
        </p>
      </section>

      <section style={sx.section}>
        <h2 style={sx.h2}>Links</h2>
        <ul style={sx.ul}>
          <li><a style={sx.link} href="https://github.com/mmchougule/b402-solana">github.com/mmchougule/b402-solana</a></li>
          <li><a style={sx.link} href="https://github.com/mmchougule/b402-solana-assurance">b402-solana-assurance</a> — independent audit harness</li>
          <li><a style={sx.link} href="https://github.com/mmchougule/b402-solana/tree/main/docs/prds">PRDs</a> — protocol spec</li>
          <li><a style={sx.link} href="https://github.com/mmchougule/b402-solana/labels/adapter">Open adapter issues</a> — Bags, Marginfi, Phoenix, pump.fun</li>
        </ul>
      </section>
    </main>
  );
}
