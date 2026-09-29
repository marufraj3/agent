import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Alzeena Fashion | Sales Agent',
  description: 'The AI sales experience for Alzeena Fashion.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
