/** Native key/value store backed by AsyncStorage. (Web: `kv.web.ts`.) */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { isQuotaError, StorageError, type KeyValueStore } from './kvTypes';

export const kv: KeyValueStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  async setItem(key, value) {
    try {
      await AsyncStorage.setItem(key, value);
    } catch (err) {
      throw new StorageError(isQuotaError(err) ? 'quota' : 'io', `Could not write "${key}".`, err);
    }
  },
  removeItem: (key) => AsyncStorage.removeItem(key),
};
