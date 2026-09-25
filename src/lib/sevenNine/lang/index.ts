/*
 * Translations bundled with the app: the backend has no lang packs, so the
 * bridge answers langpack.* from these (English is the app's own lang.ts).
 */

import type {LangPackLanguage, LangPackString} from '@layer';
import formatLangPackStrings from '@helpers/formatLangPackStrings';

export const RTL_LANG_CODES = ['ar', 'fa'];

export const BUNDLED_LANGUAGES: LangPackLanguage.langPackLanguage[] = [{
  _: 'langPackLanguage',
  pFlags: {official: true, rtl: true},
  name: 'Persian',
  native_name: 'فارسی',
  lang_code: 'fa',
  plural_code: 'fa',
  strings_count: 1,
  translated_count: 1,
  translations_url: ''
}, {
  _: 'langPackLanguage',
  pFlags: {official: true},
  name: 'English',
  native_name: 'English',
  lang_code: 'en',
  plural_code: 'en',
  strings_count: 1,
  translated_count: 1,
  translations_url: ''
}];

export function isRtlLangCode(langCode: string) {
  return RTL_LANG_CODES.includes((langCode || '').split('-')[0]);
}

/** a bundled translation, or undefined (English: the app's own strings) */
export async function loadBundledLangPack(langCode: string): Promise<{version: number, strings: LangPackString[]}> {
  if((langCode || '').split('-')[0] !== 'fa') {
    return;
  }

  const {default: fa, FA_LANG_PACK_VERSION} = await import('@lib/sevenNine/lang/fa');
  return {version: FA_LANG_PACK_VERSION, strings: formatLangPackStrings(fa)};
}

export async function loadEnglishStrings() {
  const [lang, langSign] = await Promise.all([import('@/lang'), import('@/langSign')]);
  return formatLangPackStrings(langSign.default, formatLangPackStrings(lang.default));
}
