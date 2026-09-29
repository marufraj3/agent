export type AdminActorRole = 'admin' | 'agent';

/** Lightweight identity used with the existing shared admin-password authentication. */
export interface AdminActor {
  id: string;
  role: AdminActorRole;
}

export const defaultAdminActor: AdminActor = { id: 'admin', role: 'admin' };
