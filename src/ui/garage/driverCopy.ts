/**
 * What the garage says about the roster, in one pure module so the sentences can be tested.
 *
 * The one that matters is the removal. Forgetting a driver does NOT delete their runs and
 * does NOT hand them to whoever is holding the phone now — the runs stay, and the garage
 * lists them as unassigned, which is true (`removeDriver` in `platform/driversSchema.ts`).
 * It is also irreversible in the way that counts: a run stores the id it was driven under,
 * adding the same name back mints a NEW id, and nothing reunites the two. A confirmation
 * that said "this cannot be undone" and stopped there would be describing the wrong loss —
 * the runs are not what goes, the name on them is — so the copy says which is which before
 * it offers the button.
 */
import { NO_DRIVER_LABEL, type AddDriverError, MAX_DRIVERS } from '../../platform/drivers';

/**
 * A driver's stable handle for a testID.
 *
 * NOT the driver's id. An id is minted from the clock plus four random characters
 * (`newDriverId`), so it is different on every run of the harness and a testID built from one
 * can never be named in a route file. The name is what a demo set fixes, so the name is what
 * the handle is made of; the unassigned bucket has no name and gets the word instead.
 */
export function driverHandle(driver: { id: string; name: string } | null): string {
  if (!driver) return 'unassigned';
  const slug = driver.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // A name of nothing but punctuation cannot happen — `normalizeName` would have refused it —
  // but a handle that collapses to the empty string would silently collide with the bucket.
  return slug || driver.id;
}

/** Why an add or a rename was refused. Short: it sits under a 44 dp row on a 390 pt screen. */
export function addErrorText(error: AddDriverError | null): string | null {
  if (error === 'empty') return 'A driver needs a name.';
  if (error === 'duplicate') return 'That name is already on the list.';
  if (error === 'full') return `This phone holds ${MAX_DRIVERS} drivers. Remove one first.`;
  return null;
}

export interface RemoveDriverCopy {
  title: string;
  body: string;
  detail: string;
}

/**
 * The question asked before a driver is forgotten, and the honest account of what it costs.
 *
 * `runs` is how many stored runs are filed under them. Zero is its own sentence: there is
 * nothing to become unassigned, so promising that would be inventing a consequence.
 */
export function removeDriverCopy(name: string, runs: number): RemoveDriverCopy {
  const body =
    runs === 0
      ? 'They have no runs stored, so nothing else changes. Adding the name again starts them from nothing.'
      : `Their ${runs === 1 ? 'run stays' : `${runs} runs stay`} on this phone and ${runs === 1 ? 'is' : 'are'} listed as ${NO_DRIVER_LABEL.toLowerCase()} instead. Nothing is deleted. Adding the name back does not reclaim them.`;
  return {
    title: `Forget ${name}?`,
    body,
    detail: runs === 0 ? 'No stored runs' : runs === 1 ? `1 run becomes ${NO_DRIVER_LABEL.toLowerCase()}` : `${runs} runs become ${NO_DRIVER_LABEL.toLowerCase()}`,
  };
}
