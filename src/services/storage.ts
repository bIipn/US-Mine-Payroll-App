import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StateStorage } from 'zustand/middleware';

/**
 * Device storage for the app state. If the platform storage is unavailable
 * (a locked-down browser frame, private mode), the app keeps working from
 * memory for the session instead of crashing.
 */
const memory = new Map<string, string>();
let broken = false;

export const safeStorage: StateStorage = {
  async getItem(key) {
    if (!broken) {
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        broken = true;
      }
    }
    return memory.get(key) ?? null;
  },
  async setItem(key, value) {
    if (!broken) {
      try {
        await AsyncStorage.setItem(key, value);
        return;
      } catch {
        broken = true;
      }
    }
    memory.set(key, value);
  },
  async removeItem(key) {
    memory.delete(key);
    if (!broken) {
      try {
        await AsyncStorage.removeItem(key);
      } catch {
        broken = true;
      }
    }
  },
};
