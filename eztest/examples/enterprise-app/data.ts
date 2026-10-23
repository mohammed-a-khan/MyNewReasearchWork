/**
 * Deterministic data for the enterprise example app (shared by the server and
 * the bundled client code). Nothing random: the same index always yields the
 * same order, so tests can name rows by their values.
 */
export interface Order {
  id: number;
  customer: string;
  region: string;
  status: string;
  amount: number;
  orderDate: string;
}

const CUSTOMERS = ['Contoso', 'Fabrikam', 'Northwind', 'Adventure Works', 'Litware', 'Tailspin', 'Wingtip', 'Woodgrove', 'Proseware', 'Alpine Ski House'];
const REGIONS = ['EU', 'NA', 'APAC', 'LATAM'];
const STATUSES = ['Open', 'Shipped', 'Closed', 'On hold'];

/** A small linear congruential generator, so values look varied but never change. */
function lcg(seed: number): number {
  return ((seed * 1103515245 + 12345) >>> 0) % 2147483648;
}

export function orderAt(i: number): Order {
  const id = i + 1;
  const r = lcg(id * 7919);
  const day = new Date(Date.UTC(2026, 0, 1) + (id % 365) * 86_400_000);
  return {
    id,
    // One distinctive customer far down the list (virtualization tests find it by value).
    customer: id === 9500 ? 'Zeta Logistics' : CUSTOMERS[r % CUSTOMERS.length],
    region: REGIONS[(r >> 4) % REGIONS.length],
    status: STATUSES[(r >> 8) % STATUSES.length],
    amount: Math.round(((r >> 3) % 500_000) + 1000) / 100,
    orderDate: day.toISOString().slice(0, 10),
  };
}

export function orders(n: number): Order[] {
  return Array.from({ length: n }, (_, i) => orderAt(i));
}

export const CITIES = [
  'Amsterdam', 'Athens', 'Auckland', 'Austin', 'Bangalore', 'Bangkok', 'Barcelona', 'Beijing', 'Belgrade', 'Bergen', 'Berlin', 'Berlin Heights',
  'Bern', 'Bilbao', 'Bogota', 'Bordeaux', 'Boston', 'Bratislava', 'Brisbane', 'Brussels', 'Bucharest', 'Budapest', 'Buenos Aires', 'Cairo',
  'Calgary', 'Cape Town', 'Chicago', 'Copenhagen', 'Dallas', 'Delhi', 'Denver', 'Dubai', 'Dublin', 'Edinburgh', 'Frankfurt', 'Geneva',
  'Hamburg', 'Helsinki', 'Hong Kong', 'Istanbul', 'Jakarta', 'Johannesburg', 'Kyiv', 'Lagos', 'Lima', 'Lisbon', 'Ljubljana', 'London', 'Los Angeles',
  'Luxembourg', 'Lyon', 'Madrid', 'Manila', 'Melbourne', 'Mexico City', 'Miami', 'Milan', 'Montreal', 'Moscow', 'Mumbai', 'Munich', 'Nairobi',
  'New York', 'Oslo', 'Osaka', 'Paris', 'Porto', 'Prague', 'Reykjavik', 'Riga', 'Rome', 'Rotterdam', 'San Francisco', 'Santiago', 'Sao Paulo',
  'Seattle', 'Seoul', 'Shanghai', 'Singapore', 'Sofia', 'Stockholm', 'Sydney', 'Tallinn', 'Tokyo', 'Toronto', 'Valencia', 'Vancouver', 'Vienna',
  'Vilnius', 'Warsaw', 'Washington', 'Wellington', 'Zagreb', 'Zurich',
];

export interface TreeNode {
  label: string;
  children?: TreeNode[];
}

export const REGION_TREE: TreeNode[] = [
  { label: 'Europe', children: [
    { label: 'Germany', children: [{ label: 'Berlin' }, { label: 'Munich' }, { label: 'Hamburg' }] },
    { label: 'France', children: [{ label: 'Paris' }, { label: 'Lyon' }] },
    { label: 'Spain', children: [{ label: 'Madrid' }] },
  ] },
  { label: 'Americas', children: [
    { label: 'USA', children: [{ label: 'New York' }, { label: 'Seattle' }] },
    { label: 'Canada', children: [{ label: 'Toronto' }] },
  ] },
  { label: 'Asia', children: [{ label: 'Japan', children: [{ label: 'Tokyo' }] }] },
];

export const MONTHLY_REVENUE = [120, 132, 101, 134, 90, 230, 210, 182, 191, 234, 290, 330];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Cities whose name starts with (or contains) the query, as the async option endpoints return them. */
export function searchCities(q: string): string[] {
  const s = q.trim().toLowerCase();
  if (!s) return CITIES.slice(0, 20);
  const starts = CITIES.filter((c) => c.toLowerCase().startsWith(s));
  const contains = CITIES.filter((c) => !starts.includes(c) && c.toLowerCase().includes(s));
  return [...starts, ...contains].slice(0, 20);
}
