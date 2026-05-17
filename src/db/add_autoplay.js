import { create } from 'zustand'
import {
  getUser as getStoredUser,
  setUser as setStoredUser,
  clearTokens,
} from '../lib/api'

const useAuthStore = create(function(set) {
  return {
    user: null,
    initialized: false,

    init() {
      const user = getStoredUser()

      set({
        user,
        initialized: true,
      })
    },

    setUser(user) {
      setStoredUser(user)

      set({
        user,
      })
    },

    logout() {
      clearTokens()

      set({
        user: null,
        initialized: true,
      })
    },
  }
})

export default useAuthStore