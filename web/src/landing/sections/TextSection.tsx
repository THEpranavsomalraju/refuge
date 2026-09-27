import type { TextSection as Config } from '../types';

export function TextSection({ section }: { section: Config }) {
  return (
    <div className="container prose">
      {section.title && section.showTitle !== false && <h2>{section.title}</h2>}
      {section.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
    </div>
  );
}
