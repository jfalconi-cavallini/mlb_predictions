import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MLB Daily Hitter Predictions',
  description: 'Daily MLB hitter predictions ranked by home run probability',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950">
        <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
            <span className="text-2xl">⚾</span>
            <div>
              <h1 className="font-bold text-white text-lg leading-none">MLB Hitter Predictions</h1>
              <p className="text-slate-400 text-xs">Ranked by home run probability · Updated daily</p>
            </div>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        <footer className="border-t border-slate-800 mt-12">
          <div className="max-w-7xl mx-auto px-4 py-4 text-center text-xs text-slate-600">
            Data sourced from MLB Stats API (statsapi.mlb.com) · Not affiliated with MLB
          </div>
        </footer>
      </body>
    </html>
  );
}
