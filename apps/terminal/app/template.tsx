/* App Router remounts the template on every navigation, so the enter
   animation replays per page. CSS-only; disabled under reduced motion. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
