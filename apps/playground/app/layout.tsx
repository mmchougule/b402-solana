import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'b402 — private DeFi on Solana',
  description: 'Shielded balances + composable adapters + agent-callable MCP.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
          background: '#0a0a0a',
          color: '#e6e6e6',
          minHeight: '100vh',
        }}
      >
        {children}
      </body>
    </html>
  );
}
