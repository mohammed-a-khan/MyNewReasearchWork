/**
 * The Gherkin document model produced by EZTest's parser (src/bdd/gherkin/parser.ts).
 * Every node carries its 1-based line and column in the feature file.
 */
import type { ExamplesSource } from '../../intent/examples-source.js';
import type { KeywordType } from './languages.js';

export interface Location {
  line: number;
  column: number;
}

export interface Tag {
  /** With the leading "@". */
  name: string;
  location: Location;
}

export interface Comment {
  text: string;
  location: Location;
}

export interface TableCell {
  value: string;
  location: Location;
}

export interface TableRow {
  cells: TableCell[];
  location: Location;
}

export interface DataTable {
  rows: TableRow[];
  location: Location;
}

export interface DocString {
  content: string;
  /** `"""` or three backticks. */
  delimiter: string;
  /** Text after the opening delimiter (`json`, `xml`, ...). */
  mediaType?: string;
  location: Location;
}

export interface Step {
  keyword: string;
  keywordType: KeywordType;
  text: string;
  docString?: DocString;
  dataTable?: DataTable;
  location: Location;
}

export interface Examples {
  keyword: string;
  name: string;
  description: string;
  tags: Tag[];
  tableHeader?: TableRow;
  tableBody: TableRow[];
  /** EZTest extension: `Examples: from data "file.xlsx" sheet "S" where ...` (rows read when the run starts). */
  source?: ExamplesSource;
  location: Location;
}

export interface Background {
  kind: 'background';
  keyword: string;
  name: string;
  description: string;
  steps: Step[];
  location: Location;
}

export interface Scenario {
  kind: 'scenario';
  keyword: string;
  name: string;
  description: string;
  tags: Tag[];
  steps: Step[];
  examples: Examples[];
  /** Written with an outline keyword (Scenario Outline / Scenario Template), or has Examples. */
  outline: boolean;
  location: Location;
}

export interface Rule {
  kind: 'rule';
  keyword: string;
  name: string;
  description: string;
  tags: Tag[];
  children: Array<Background | Scenario>;
  location: Location;
}

export interface Feature {
  keyword: string;
  name: string;
  description: string;
  tags: Tag[];
  language: string;
  children: Array<Background | Scenario | Rule>;
  location: Location;
}

export interface GherkinDocument {
  uri: string;
  /** Absent for a file without a Feature line (only comments or blank lines). */
  feature?: Feature;
  comments: Comment[];
}
