import { createClient } from '@supabase/supabase-js';

// Замени эти значения на свои из Supabase Dashboard → Settings → API
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Получить или создать анонимный ID пользователя
export function getUserId() {
  let uid = localStorage.getItem('vital_uid');
  if (!uid) {
    uid = crypto.randomUUID();
    localStorage.setItem('vital_uid', uid);
  }
  return uid;
}
