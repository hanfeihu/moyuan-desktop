import { useEffect, useState } from 'react'
import { defaultEmployees, defaultImageSkill, defaultPaymentGateway, defaultPolicy, defaultProviders, defaultTokenPlans, defaultVideoSkill } from '@/data/defaults'
import { loadAdminSnapshot, type AdminSnapshot } from '@/services/admin'

const initialSnapshot: AdminSnapshot = {
  apiState: 'checking',
  employees: defaultEmployees,
  modelProvider: defaultProviders[0],
  policy: defaultPolicy,
  providers: defaultProviders,
  imageSkill: defaultImageSkill,
  videoSkill: defaultVideoSkill,
  plugins: [],
  paymentGateway: defaultPaymentGateway,
  tokenPlans: defaultTokenPlans,
}

export function useAdminSnapshot() {
  const [snapshot, setSnapshot] = useState<AdminSnapshot>(initialSnapshot)

  useEffect(() => {
    let mounted = true
    loadAdminSnapshot().then((payload) => {
      if (mounted) setSnapshot(payload)
    })
    return () => {
      mounted = false
    }
  }, [])

  return snapshot
}
