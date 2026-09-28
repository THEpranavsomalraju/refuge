import { Analytics } from '@vercel/analytics/react';
import { Landing } from './landing/Landing';

// App shell. The page layout lives in web/src/landing (edit site.config.ts to change it);
// the 3D town and game UI mount inside its game section.
export function App() {
  return (
    <>
      <Landing />
      <Analytics />
    </>
  );
}
