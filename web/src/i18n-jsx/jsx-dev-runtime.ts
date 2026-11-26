import * as R from 'react/jsx-dev-runtime'
import { fixProps } from '../i18n'

export type { JSX } from 'react/jsx-dev-runtime'
export const Fragment = R.Fragment
export const jsxDEV = (type: any, props: any, key: any, isStatic: boolean, source: any, self: any) =>
  R.jsxDEV(type, fixProps(type, props), key, isStatic, source, self)
