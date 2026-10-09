// Where the reader was before a jump (a table-of-contents entry, an
// annotation, a glossary reference, a search result, later a citation) —
// so "Back" can return them to it.
//
// A place is a page plus how far down that page the top of the viewport
// was, as a fraction of the page's height: unlike a raw scrollTop, it still
// points at the same spot after the reader zooms.
export interface ReadingPlace {
  pageNumber: number;
  offset: number; // 0 = page top at viewport top, 0.5 = viewport top mid-page
}

export interface PageBounds {
  top: number; // in the scroll container's scrollTop coordinates
  bottom: number;
}

export function placeFromScroll(scrollTop: number, pageNumber: number, bounds: PageBounds): ReadingPlace {
  const height = bounds.bottom - bounds.top;
  const offset = height > 0 ? (scrollTop - bounds.top) / height : 0;
  return { pageNumber, offset: Math.min(1, Math.max(0, offset)) };
}

export function scrollTopForPlace(place: ReadingPlace, bounds: PageBounds): number {
  return bounds.top + place.offset * (bounds.bottom - bounds.top);
}

const MAX_PLACES = 20;

// Two places this close together (same page, within 2% of its height) are
// the same place.
function samePlace(a: ReadingPlace, b: ReadingPlace): boolean {
  return a.pageNumber === b.pageNumber && Math.abs(a.offset - b.offset) < 0.02;
}

// Back and Forward, as in a browser: each jump records the place left, and
// going back (or forward) over places keeps the one left on the other side,
// so the reader can retrace it. A new jump starts a new trail: whatever was
// ahead is forgotten. Each list keeps its most recent entries, dropping the
// oldest past MAX_PLACES.
export class NavigationHistory {
  // Most recent last, in both.
  private backPlaces: ReadingPlace[] = [];
  private forwardPlaces: ReadingPlace[] = [];

  // The reader is leaving `place` for somewhere new.
  push(place: ReadingPlace) {
    this.forwardPlaces = [];
    const last = this.backPlaces[this.backPlaces.length - 1];
    if (last && samePlace(last, place)) return;
    add(this.backPlaces, place);
  }

  // A new jump that leaves no place worth keeping (see rememberPlace) still
  // starts a new trail.
  discardForward() {
    this.forwardPlaces = [];
  }

  // Steps back over `steps` places and returns the one to go to. `current`
  // (where the reader is now), and any places stepped over, go to Forward.
  back(current: ReadingPlace | null, steps = 1): ReadingPlace | null {
    return step(this.backPlaces, this.forwardPlaces, current, steps);
  }

  forward(current: ReadingPlace | null, steps = 1): ReadingPlace | null {
    return step(this.forwardPlaces, this.backPlaces, current, steps);
  }

  // Nearest first: the first is where one step goes.
  backList(): ReadingPlace[] {
    return [...this.backPlaces].reverse();
  }

  forwardList(): ReadingPlace[] {
    return [...this.forwardPlaces].reverse();
  }

  clear() {
    this.backPlaces = [];
    this.forwardPlaces = [];
  }
}

function add(places: ReadingPlace[], place: ReadingPlace) {
  places.push(place);
  if (places.length > MAX_PLACES) places.shift();
}

function step(from: ReadingPlace[], to: ReadingPlace[], current: ReadingPlace | null, steps: number) {
  if (steps < 1 || steps > from.length) return null;
  if (current) add(to, current);
  for (let i = 1; i < steps; i += 1) add(to, from.pop()!);
  return from.pop()!;
}
