/**
 * default-foundation.js — generic System Definition mode (Modern RPG)
 *
 * Ported from the Fatbody Framework (same author, MIT).
 *
 * The built-in "Default" foundation: a complete, schema-valid Modern
 * campaign contract that works with ANY character card. Committing it skips
 * the Foundation Builder interview entirely — the user lands straight on
 * the HUD class selection and the Skill Forge grows the tree per-chat as usual.
 *
 * The setting is deliberately setting-agnostic ("The Awakened World"): it
 * describes how power works, not where the story happens, so it layers onto
 * fantasy, modern, sci-fi, or slice-of-life cards without contradiction.
 *
 * Pure data module (node-testable). No ST access, no DOM.
 *
 * Imports: foundation.js (schema version only)
 * Imported by: index.js (Modern "Default" path), renderer.js (class emojis)
 */

import { FOUNDATION_SCHEMA_VERSION } from './foundation.js';

/** Canonical ids of the six default classes, in display order. */
export const DEFAULT_CLASS_IDS = ['fighter', 'monk', 'bard', 'rogue', 'ranger', 'wizard'];

/**
 * Builds a fresh default foundation document. Factory (not a shared constant)
 * because commitFoundation() stamps version metadata onto the object and the
 * progression engine mutates downstream copies — a module-level singleton
 * would leak state between campaigns.
 *
 * @returns {object} schema-valid foundation (validateFoundation → ok, no errors)
 */
export function defaultFoundation() {
    return {
        schemaVersion: FOUNDATION_SCHEMA_VERSION,
        mode: 'modern',
        SETTING: {
            name: 'The Awakened World',
            synopsis: 'The world is exactly as the story already shows it — except that latent potential, called the Awakening, sleeps in everyone. Those who awaken channel it through one of six time-honored disciplines, growing from ordinary capability into legend one hard-won skill at a time.',
            themes: ['growth', 'discipline', 'adventure', 'mastery'],
            toneNotes: 'Adapts to the host story: keep the existing tone and genre, layer progression mechanics on top without rewriting the world.',
        },
        POWER_SYSTEM: {
            name: 'The Awakening',
            description: 'Awakened potential expresses through three pools: Stamina drives feats of muscle and endurance, Mana fuels channeled arcane or anomalous power, and Focus sharpens precision, perception, and inner discipline. Skills draw on the pool their discipline favors.',
            resources: [
                { id: 'stamina', name: 'Stamina', description: 'Physical exertion pool for feats of strength, endurance, and martial technique.', regenRule: 'Recovers fully on a long rest; a short breather restores half.' },
                { id: 'mana', name: 'Mana', description: 'Channeled arcane potential fueling spells, songs of power, and supernatural effects.', regenRule: 'Recovers fully on a long rest; meditation or quiet study restores a quarter.' },
                { id: 'focus', name: 'Focus', description: 'Concentration and inner discipline spent on precision strikes, stealth, and heightened awareness.', regenRule: 'Recovers fully on a short rest; breaks under sustained chaos.' },
            ],
            diceProfile: {
                primary: 'd20',
                subdice: ['d4', 'd6', 'd8', 'd10', 'd12'],
                queueLen: 12,
                dcScale: [
                    { label: 'Trivial', value: 5 },
                    { label: 'Easy', value: 10 },
                    { label: 'Moderate', value: 15 },
                    { label: 'Hard', value: 20 },
                    { label: 'Near-impossible', value: 30 },
                ],
            },
        },
        PROGRESSION_RULES: {
            maxLevel: 100,
            xpCurveId: 'modern_v1',
            skillPointsPerLevel: 2,
            milestoneEvery: 10,
            milestoneBonus: 4,
            respec: { freeUntilLevel: 10, currencyName: 'gold', costMultiplier: 1.0 },
        },
        CLASS_ROSTER: [
            {
                id: 'fighter',
                name: 'Fighter',
                fantasy: 'Master of weapons and armor who dominates the front line through training and sheer durability.',
                role: 'tank',
                primaryResource: 'stamina',
                treeThemes: ['weapon mastery', 'defense', 'battlefield control', 'endurance'],
            },
            {
                id: 'monk',
                name: 'Monk',
                fantasy: 'Disciplined martial artist whose inner focus turns body and breath into the only weapon needed.',
                role: 'hybrid',
                primaryResource: 'focus',
                treeThemes: ['martial arts', 'speed', 'inner discipline', 'deflection'],
            },
            {
                id: 'bard',
                name: 'Bard',
                fantasy: 'Performer whose music and silver tongue inspire allies, sway hearts, and unravel enemies.',
                role: 'support',
                primaryResource: 'mana',
                treeThemes: ['inspiration', 'enchantment', 'lore', 'social influence'],
            },
            {
                id: 'rogue',
                name: 'Rogue',
                fantasy: 'Swift and cunning operator who strikes from shadow with precision, deception, and perfect timing.',
                role: 'damage',
                primaryResource: 'focus',
                treeThemes: ['stealth', 'precision strikes', 'deception', 'agility'],
            },
            {
                id: 'ranger',
                name: 'Ranger',
                fantasy: 'Expert tracker and marksman, deadly at range and unmatched in wild or hostile territory.',
                role: 'damage',
                primaryResource: 'stamina',
                treeThemes: ['ranged combat', 'tracking', 'survival', 'beast lore'],
            },
            {
                id: 'wizard',
                name: 'Wizard',
                fantasy: 'Scholar of raw arcane power who bends the battlefield through study, intellect, and devastating spellwork.',
                role: 'control',
                primaryResource: 'mana',
                treeThemes: ['elemental magic', 'battlefield control', 'arcane knowledge', 'wards'],
            },
        ],
        JOB_RULES: {
            enabled: true,
            maxJobs: 2,
            unlockNarrative: 'Jobs unlock through in-story commitment: apprenticing to a mentor, joining an organization, or proving mastery of a craft.',
            jobSeeds: [
                { id: 'artisan', name: 'Artisan', description: 'Crafter of equipment, tools, and consumables that support the party.', unlockHint: 'Study under a master craftsman or complete a signature work.' },
                { id: 'mercenary', name: 'Mercenary', description: 'Professional soldier-for-hire with contacts, contracts, and dirty tricks.', unlockHint: 'Take and complete a paid contract from a guild or patron.' },
            ],
        },
        SKILL_TAXONOMY: {
            damageTypes: ['slashing', 'piercing', 'bludgeoning', 'fire', 'frost', 'lightning', 'radiant', 'shadow'],
            namingConvention: 'Short evocative names in plain language (two to three words), e.g. "Riposte", "Shadow Step", "Arcane Lattice".',
            rarityTiers: [
                { id: 'common', name: 'Common', color: '#aaaaaa' },
                { id: 'uncommon', name: 'Uncommon', color: '#4caf50' },
                { id: 'rare', name: 'Rare', color: '#5588ff' },
                { id: 'epic', name: 'Epic', color: '#aa55ff' },
                { id: 'legendary', name: 'Legendary', color: '#ff8800' },
            ],
            tierCount: 10,
            levelGatePerTier: 10,
        },
        LETHALITY: {
            template: 'standard',
            downedWindow: 3,
            injuryTable: [
                'Deep gash (-2 to physical checks until treated)',
                'Cracked ribs (-10 max Stamina)',
                'Concussion (-2 to Focus-based checks)',
                'Mangled hand (-2 to fine manipulation and weapon checks)',
                'Burned arm (-10 max Mana, channeling is painful)',
                'Torn leg muscle (movement halved until healed)',
                'Lost eye (-2 to ranged and perception checks, permanent unless restored)',
            ],
            deathRule: 'A third permanent injury, or an unsurvivable narrative event, means true death.',
        },
    };
}

/**
 * Emoji crest per default class. Class-selection buttons show these;
 * AI-generated rosters with other ids fall back to a role emoji via
 * classEmoji(), so every class always renders with an icon.
 */
export const CLASS_EMOJIS = {
    fighter: '⚔️',
    monk: '🥋',
    bard: '🎶',
    rogue: '🗡️',
    ranger: '🏹',
    wizard: '🧙',
};

const ROLE_EMOJIS = { damage: '💥', control: '🌀', support: '💖', tank: '🛡️', hybrid: '🌗' };

/**
 * Emoji for a roster class: id match → role fallback → generic sparkle.
 * @param {{id?: string, role?: string}|null|undefined} cls
 * @returns {string}
 */
export function classEmoji(cls) {
    return CLASS_EMOJIS[cls?.id] || ROLE_EMOJIS[cls?.role] || '✨';
}
