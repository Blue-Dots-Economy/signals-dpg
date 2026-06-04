export interface NetworkThemeCopy {
  lead: string;
  highlight: string;
  tail: string;
}

export interface NetworkStat {
  value: string;
  label: string;
}

export interface NetworkThemeTokens {
  '--primary': string;
  '--primary-foreground': string;
  '--secondary': string;
  '--secondary-foreground': string;
  '--accent': string;
  '--accent-foreground': string;
  '--ring': string;
  '--sidebar-primary': string;
  '--sidebar-primary-foreground': string;
  '--sidebar-accent': string;
  '--sidebar-accent-foreground': string;
  '--sidebar-ring': string;
  '--brand-hero-from': string;
  '--brand-hero-to': string;
  '--brand-hero-highlight': string;
  '--brand-hero-glow': string;
  '--brand-stat-accent': string;
  '--brand-cta': string;
  '--brand-cta-foreground': string;
}

export interface NetworkTheme {
  name: string;
  tagline: NetworkThemeCopy;
  subline: string;
  portalLabel: string;
  inviteLine: string;
  stats: NetworkStat[];
  tokens: NetworkThemeTokens;
}

// TODO: Add dark-mode token variants per network when dark-mode toggle ships.

const blue_dot: NetworkTheme = {
  name: 'Blue Dots',
  tagline: {
    lead: 'Connecting',
    highlight: 'opportunity',
    tail: 'seekers with the right doors.',
  },
  subline:
    'A unified network where aggregators, providers, and seekers move together — every blue dot is a person, an opportunity, a path forward.',
  portalLabel: 'Seeker & Provider Portal',
  inviteLine: 'Invite-only · Blue Dots DPG',
  stats: [],
  tokens: {
    '--primary': 'oklch(0.55 0.20 250)',
    '--primary-foreground': 'oklch(0.985 0 0)',
    '--secondary': 'oklch(0.94 0.04 250)',
    '--secondary-foreground': 'oklch(0.20 0 0)',
    '--accent': 'oklch(0.94 0.04 250)',
    '--accent-foreground': 'oklch(0.20 0 0)',
    '--ring': 'oklch(0.65 0.15 250)',
    '--sidebar-primary': 'oklch(0.55 0.20 250)',
    '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
    '--sidebar-accent': 'oklch(0.96 0.03 250)',
    '--sidebar-accent-foreground': 'oklch(0.25 0 0)',
    '--sidebar-ring': 'oklch(0.65 0.15 250)',
    '--brand-hero-from': '#0b1530',
    '--brand-hero-to': '#1a2554',
    '--brand-hero-highlight': '#7da8ff',
    '--brand-hero-glow': '#5b8def',
    '--brand-stat-accent': '#7da8ff',
    '--brand-cta': 'oklch(0.55 0.22 285)',
    '--brand-cta-foreground': '#ffffff',
  },
};

const purple_dot: NetworkTheme = {
  name: 'Purple Dot',
  tagline: {
    lead: 'Empowering',
    highlight: 'every ability',
    tail: 'to find the support it deserves.',
  },
  subline:
    'A unified network connecting persons with disabilities to assistive devices, health services, and rehabilitation support — every purple dot is a door to a better life.',
  portalLabel: 'Services Portal',
  inviteLine: 'Invite-only · Purple Dot DPG',
  stats: [],
  tokens: {
    '--primary': 'oklch(0.55 0.22 300)',
    '--primary-foreground': 'oklch(0.985 0 0)',
    '--secondary': 'oklch(0.94 0.04 300)',
    '--secondary-foreground': 'oklch(0.20 0 0)',
    '--accent': 'oklch(0.94 0.04 300)',
    '--accent-foreground': 'oklch(0.20 0 0)',
    '--ring': 'oklch(0.65 0.15 300)',
    '--sidebar-primary': 'oklch(0.55 0.22 300)',
    '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
    '--sidebar-accent': 'oklch(0.96 0.03 300)',
    '--sidebar-accent-foreground': 'oklch(0.25 0 0)',
    '--sidebar-ring': 'oklch(0.65 0.15 300)',
    '--brand-hero-from': '#1a0b30',
    '--brand-hero-to': '#2d1354',
    '--brand-hero-highlight': '#c4a8ff',
    '--brand-hero-glow': '#a87bef',
    '--brand-stat-accent': '#c4a8ff',
    '--brand-cta': 'oklch(0.55 0.22 300)',
    '--brand-cta-foreground': '#ffffff',
  },
};

const yellow_dot: NetworkTheme = {
  name: 'Yellow Dot',
  tagline: {
    lead: 'Connecting',
    highlight: 'learners',
    tail: 'with the educators who shape futures.',
  },
  subline:
    'A unified education network where students find tutors, counsellors, and coaching centres — every yellow dot is a step forward on the learning path.',
  portalLabel: 'Education Portal',
  inviteLine: 'Invite-only · Yellow Dot DPG',
  stats: [],
  tokens: {
    '--primary': 'oklch(0.68 0.18 80)',
    '--primary-foreground': 'oklch(0.12 0 0)',
    '--secondary': 'oklch(0.94 0.05 80)',
    '--secondary-foreground': 'oklch(0.20 0 0)',
    '--accent': 'oklch(0.94 0.05 80)',
    '--accent-foreground': 'oklch(0.20 0 0)',
    '--ring': 'oklch(0.60 0.15 80)',
    '--sidebar-primary': 'oklch(0.68 0.18 80)',
    '--sidebar-primary-foreground': 'oklch(0.12 0 0)',
    '--sidebar-accent': 'oklch(0.95 0.04 80)',
    '--sidebar-accent-foreground': 'oklch(0.25 0 0)',
    '--sidebar-ring': 'oklch(0.60 0.15 80)',
    '--brand-hero-from': '#1e1300',
    '--brand-hero-to': '#2e1f00',
    '--brand-hero-highlight': '#ffd080',
    '--brand-hero-glow': '#f5a623',
    '--brand-stat-accent': '#ffd080',
    '--brand-cta': 'oklch(0.68 0.18 80)',
    '--brand-cta-foreground': 'oklch(0.12 0 0)',
  },
};

const pink_dot: NetworkTheme = {
  name: 'Pink Dot',
  tagline: {
    lead: 'Nurturing',
    highlight: 'early childhood',
    tail: 'with the care every child deserves.',
  },
  subline:
    'A unified network for early-childhood care and education — every pink dot connects a child to a carer, a parent to a resource, a community to a future.',
  portalLabel: 'Care Portal',
  inviteLine: 'Invite-only · Pink Dot DPG',
  stats: [],
  tokens: {
    '--primary': 'oklch(0.60 0.22 350)',
    '--primary-foreground': 'oklch(0.985 0 0)',
    '--secondary': 'oklch(0.95 0.04 350)',
    '--secondary-foreground': 'oklch(0.20 0 0)',
    '--accent': 'oklch(0.95 0.04 350)',
    '--accent-foreground': 'oklch(0.20 0 0)',
    '--ring': 'oklch(0.70 0.15 350)',
    '--sidebar-primary': 'oklch(0.60 0.22 350)',
    '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
    '--sidebar-accent': 'oklch(0.96 0.03 350)',
    '--sidebar-accent-foreground': 'oklch(0.25 0 0)',
    '--sidebar-ring': 'oklch(0.70 0.15 350)',
    '--brand-hero-from': '#1f0b14',
    '--brand-hero-to': '#3d1528',
    '--brand-hero-highlight': '#ffaac8',
    '--brand-hero-glow': '#ef4d7a',
    '--brand-stat-accent': '#ffaac8',
    '--brand-cta': 'oklch(0.60 0.22 350)',
    '--brand-cta-foreground': '#ffffff',
  },
};

const green_dot: NetworkTheme = {
  name: 'Green Dot',
  tagline: {
    lead: 'Growing',
    highlight: 'livelihoods',
    tail: 'through connected agriculture networks.',
  },
  subline:
    'A unified agri-network where farmers, buyers, and support services converge — every green dot is a harvest made possible by the right connection.',
  portalLabel: 'Agri Portal',
  inviteLine: 'Invite-only · Green Dot DPG',
  stats: [],
  tokens: {
    '--primary': 'oklch(0.55 0.18 155)',
    '--primary-foreground': 'oklch(0.985 0 0)',
    '--secondary': 'oklch(0.94 0.04 155)',
    '--secondary-foreground': 'oklch(0.20 0 0)',
    '--accent': 'oklch(0.94 0.04 155)',
    '--accent-foreground': 'oklch(0.20 0 0)',
    '--ring': 'oklch(0.65 0.13 155)',
    '--sidebar-primary': 'oklch(0.55 0.18 155)',
    '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
    '--sidebar-accent': 'oklch(0.96 0.03 155)',
    '--sidebar-accent-foreground': 'oklch(0.25 0 0)',
    '--sidebar-ring': 'oklch(0.65 0.13 155)',
    '--brand-hero-from': '#071a0e',
    '--brand-hero-to': '#0d2d18',
    '--brand-hero-highlight': '#86efb0',
    '--brand-hero-glow': '#22c55e',
    '--brand-stat-accent': '#86efb0',
    '--brand-cta': 'oklch(0.55 0.18 155)',
    '--brand-cta-foreground': '#ffffff',
  },
};

const orange_dot: NetworkTheme = {
  name: 'Orange Dots',
  tagline: {
    lead: 'Discovering',
    highlight: 'verified locals',
    tail: 'for every traveller exploring Udupi.',
  },
  subline:
    'A unified tourism, arts & culture network connecting travellers to verified practitioners — every orange dot is a guide, an artisan, a stay, an experience worth finding.',
  portalLabel: 'Tourism & Culture Portal',
  inviteLine: 'Invite-only · Orange Dots DPG',
  stats: [],
  tokens: {
    '--primary': 'oklch(0.66 0.18 50)',
    '--primary-foreground': 'oklch(0.985 0 0)',
    '--secondary': 'oklch(0.95 0.05 65)',
    '--secondary-foreground': 'oklch(0.20 0 0)',
    '--accent': 'oklch(0.95 0.05 65)',
    '--accent-foreground': 'oklch(0.20 0 0)',
    '--ring': 'oklch(0.70 0.15 50)',
    '--sidebar-primary': 'oklch(0.66 0.18 50)',
    '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
    '--sidebar-accent': 'oklch(0.96 0.04 65)',
    '--sidebar-accent-foreground': 'oklch(0.25 0 0)',
    '--sidebar-ring': 'oklch(0.70 0.15 50)',
    '--brand-hero-from': '#7c2d12',
    '--brand-hero-to': '#c2410c',
    '--brand-hero-highlight': '#fb923c',
    '--brand-hero-glow': '#f97316',
    '--brand-stat-accent': '#facc15',
    '--brand-cta': 'oklch(0.66 0.18 50)',
    '--brand-cta-foreground': '#ffffff',
  },
};

export const networkThemes: Record<string, NetworkTheme> = {
  blue_dot,
  purple_dot,
  yellow_dot,
  pink_dot,
  green_dot,
  orange_dot,
};

export function resolveTheme(networkId: string | null | undefined): NetworkTheme {
  if (networkId && networkId in networkThemes) {
    return networkThemes[networkId];
  }
  return blue_dot;
}
