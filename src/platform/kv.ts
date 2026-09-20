/** Native key/value store backed by AsyncStorage. (Web: `kv.web.ts`.) */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { isQuotaError, sizeKb, StorageError, type KeyValueStore } from './kvTypes';

export const kv: KeyValueStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  async setItem(key, value) {
    try {
      await AsyncStorage.setItem(key, value);
    } catch (err) {
      throw isQuotaError(err)
        ? new StorageError('quota', `Your phone is out of space — the last ${sizeKb(value)} KB would not fit.`, err, `setItem "${key}"`)
        : new StorageError('io', 'Your phone would not let the app write to its storage.', err, `setItem "${key}"`);
    }
  },
  removeItem: (key) => AsyncStorage.removeItem(key),
};
