/**
 * Multi-actor phrasings (docs/multi-actor.md):
 *
 *   As manager:                          <- the following lines run as manager (until the next "As ...", an End, or the end of the file)
 *   As "customer": click the "Pay" button  <- one step as customer
 *   Switch to user "bob"                 <- the following steps of this list run as bob
 *   In parallel:                         <- the As blocks inside run at the same time (closed by End)
 *   In parallel: as bob: <step>          <- (one inline branch)
 *
 * Deterministic regexes like the rest of the grammar; nothing is evaluated.
 */
import { literal } from './quotes.js';
import { innerStep } from './rules-advanced.js';
import type { IntentRule } from './rules.js';

const Q = String.raw`⟦\d+⟧`;
const NAME = String.raw`(${Q}|[A-Za-z_][\w.-]*)`;

export const ACTOR_RULES: IntentRule[] = [
  { name: 'as-actor', keywords: ['as'], category: 'Actors', example: 'As manager: click the "Approve" button',
    re: new RegExp(String.raw`^as\s+(?:(?:the\s+)?(?:user|actor)\s+)?${NAME}\s*:\s*(.*)$`, 'i'),
    build: (m, q) => ({ action: 'actor', value: literal(m[1], q), steps: m[2]?.trim() ? innerStep(m[2], q) : [] }) },
  { name: 'switch-actor', keywords: ['continue', 'user'], category: 'Actors', example: 'Switch to user "bob"',
    re: new RegExp(String.raw`^(?:(?:switch|change|go)\s+(?:back\s+)?to\s+(?:the\s+)?(?:user|actor)\s+${NAME}|continue\s+as\s+(?:(?:the\s+)?(?:user|actor)\s+)?${NAME})$`, 'i'),
    build: (m, q) => ({ action: 'actor', value: literal(m[1] ?? m[2], q) }) },
  // Usually an opener followed by As sections and End; "In parallel: as bob: <step>" carries one branch inline.
  { name: 'in-parallel', keywords: ['parallel', 'concurrently', 'simultaneously'], category: 'Actors', example: 'In parallel: as bob: click the "Send" button',
    re: /^(?:in\s+parallel|at\s+the\s+same\s+time|concurrently|simultaneously)(?:\s+do)?\s*(?::\s*(.*))?$/i,
    build: (m, q) => ({ action: 'parallel', steps: m[1]?.trim() ? innerStep(m[1], q) : [] }) },
];
