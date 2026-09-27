// Past disasters (ML lead, ml/past_events/). The scenario runs unchanged; the town folder
// places/<id>/ comes from Structures and equals scenario.place_id.
import estill from '../../../ml/past_events/estill_sc_2020.json';
import valleyView from '../../../ml/past_events/valley_view_tx_2024.json';
import michael from '../../../ml/past_events/michael_mexico_beach_2018.json';
import florence from '../../../ml/past_events/florence_wilmington_2018.json';

export interface PastEvent {
  id: string;
  title: string;
  subtitle: string;
  hazard: 'tornado' | 'hurricane';
  recorded: {
    deaths_direct: number;
    injuries_direct?: number;
    death_locations?: Record<string, number>;
    property_damage_usd?: number;
    zones?: string[];
    source?: string;
  };
  scenario: { place_id: string; hazard: string; [key: string]: unknown };
  notes: string[];
}

export const PAST_EVENTS = [estill, valleyView, michael, florence] as unknown as PastEvent[];
