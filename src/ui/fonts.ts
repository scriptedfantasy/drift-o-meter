/**
 * Font loading. Registers exactly the Barlow / Barlow Condensed faces the design system uses,
 * under the family names in `theme.fontFamilies`, and exposes a hook the root layout uses to
 * hold the splash screen until they are ready.
 */
import {
  BarlowCondensed_600SemiBold,
  BarlowCondensed_600SemiBold_Italic,
  BarlowCondensed_700Bold,
  BarlowCondensed_700Bold_Italic,
  BarlowCondensed_800ExtraBold,
  BarlowCondensed_800ExtraBold_Italic,
} from '@expo-google-fonts/barlow-condensed';
import { Barlow_400Regular, Barlow_500Medium, Barlow_600SemiBold } from '@expo-google-fonts/barlow';
import { useFonts } from 'expo-font';

import { fontFamilies } from './theme';

export const fontAssets = {
  [fontFamilies.display.semibold]: BarlowCondensed_600SemiBold,
  [fontFamilies.display.semiboldItalic]: BarlowCondensed_600SemiBold_Italic,
  [fontFamilies.display.bold]: BarlowCondensed_700Bold,
  [fontFamilies.display.boldItalic]: BarlowCondensed_700Bold_Italic,
  [fontFamilies.display.extrabold]: BarlowCondensed_800ExtraBold,
  [fontFamilies.display.extraboldItalic]: BarlowCondensed_800ExtraBold_Italic,
  [fontFamilies.body.regular]: Barlow_400Regular,
  [fontFamilies.body.medium]: Barlow_500Medium,
  [fontFamilies.body.semibold]: Barlow_600SemiBold,
} as const;

export interface AppFontsState {
  /** True once every face is registered (or loading failed and we fall back). */
  loaded: boolean;
  error: Error | null;
}

/** Loads the app fonts. The root layout keeps the splash screen up until `loaded`. */
export function useAppFonts(): AppFontsState {
  const [loaded, error] = useFonts(fontAssets);
  return { loaded, error: error ?? null };
}
