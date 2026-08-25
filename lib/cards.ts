import type { Rarity } from './rules';

export interface Card {
  id: string;
  version: number;
  name: string;
  rarity: Rarity;
  imageKey: string;
  skillName: string;
  skillDescription: string;
  flavorText: string;
  attack: number;
  defense: number;
  luck: number;
}
