import type { ComponentType } from 'react';
import type { SectionConfig, SectionKind } from './types';
import { ChartsSection } from './sections/ChartsSection';
import { GameSection } from './sections/GameSection';
import { HeroSection } from './sections/HeroSection';
import { Placeholder } from './sections/Placeholder';
import { TextSection } from './sections/TextSection';

type Renderer<K extends SectionKind> = ComponentType<{ section: Extract<SectionConfig, { kind: K }> }>;

// kind → component. A new section kind is one line here (TypeScript flags a missing one).
export const SECTION_TYPES: { [K in SectionKind]: Renderer<K> } = {
  hero: HeroSection,
  game: GameSection,
  charts: ChartsSection,
  text: TextSection,
  placeholder: Placeholder,
};
