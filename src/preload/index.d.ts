import type { NarsilApi } from '../shared/types'

declare global {
  interface Window {
    narsil: NarsilApi
  }
}

export {}
