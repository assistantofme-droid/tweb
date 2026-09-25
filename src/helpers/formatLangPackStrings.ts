import type {LangPackString} from '@layer';

/**
 * A lang object as the app keeps it locally ({key: value}, plurals as
 * {one_value, other_value, ...}) turned into lang pack strings.
 */
export default function formatLangPackStrings(strings: {[key: string]: any}, pushTo: LangPackString[] = []) {
  for(const key in strings) {
    const value = strings[key];
    if(typeof(value) === 'string') {
      pushTo.push({
        _: 'langPackString',
        key,
        value
      });
    } else {
      pushTo.push({
        _: 'langPackStringPluralized',
        key,
        ...value
      });
    }
  }

  return pushTo;
}
