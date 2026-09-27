// Section config types. Each `kind` is one section renderer (see sectionTypes.tsx).
// Adding a kind: add an interface here, add it to SectionConfig, register a component.

interface Base {
  /** Anchor id, used by the nav (#id). Unique. */
  id: string;
  title?: string;
  /** Show in the top nav. Default true when the section has a title. */
  nav?: boolean;
  /** Render the title as a heading. Set false when the content has its own (it still names the nav link). */
  showTitle?: boolean;
}

export interface HeroSection extends Base { kind: 'hero' }

export interface GameSection extends Base { kind: 'game'; height?: string }

export interface ChartSpec {
  /** Folder in web/public/charts/ (e.g. 'deaths-by-hour') or a full URL. */
  src: string;
  title: string;
  /** Pixel height. Charts can also report their own height (see README). */
  height?: number;
  /** Span both grid columns on wide screens. */
  wide?: boolean;
  /** No card or caption, for charts that carry their own heading. */
  bare?: boolean;
  /** Cover the chart until clicked, so maps that zoom on scroll don't trap page scrolling. */
  clickToInteract?: boolean;
}

export interface ChartsSection extends Base { kind: 'charts'; intro?: string; charts: ChartSpec[] }

export interface TextSection extends Base { kind: 'text'; paragraphs: string[] }

export interface PlaceholderSection extends Base { kind: 'placeholder'; note?: string }

export type SectionConfig = HeroSection | GameSection | ChartsSection | TextSection | PlaceholderSection;
export type SectionKind = SectionConfig['kind'];
