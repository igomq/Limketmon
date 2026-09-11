import type { Rarity } from './rules';

export interface Card {
  id: string;
  /** Catalog id this owned row was derived from. Absent on plain catalog cards. */
  baseCardId?: string;
  version: number;
  name: string;
  alias?: string;
  rarity: Rarity;
  imageKey: string;
  skillName: string;
  skillDescription: string;
  flavorText: string;
  attack: number;
  defense: number;
  luck: number;
  visualTags?: string[];
}
