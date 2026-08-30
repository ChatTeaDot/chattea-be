export type ConsumableUnits = Readonly<{
  superLikeCredits: number;
  boostCredits: number;
}>;

export type RevenueCatTransactionState = "granted" | "refunded";

export type RevenueCatSubscription = Readonly<{
  planId: string;
  providerCustomerId?: string;
  providerProductId: string;
  eventTimestampMs: number;
  startsAt?: Date;
  endsAt?: Date;
  status: "active" | "expired";
}>;

export type RevenueCatConsumableTransition = Readonly<{
  providerTransactionId: string;
  originalTransactionId: string;
  userId: string;
  canonicalProductId: string;
  providerProductId: string;
  eventTimestampMs: number;
  targetState: RevenueCatTransactionState;
  units: ConsumableUnits;
}>;

export type RevenueCatRecordedEvent = Readonly<{
  providerEventId: string;
  payloadHash: string;
}>;

export type RevenueCatEventInput =
  | RevenueCatRecordedEvent
  | (RevenueCatRecordedEvent & { userId: string; subscription: RevenueCatSubscription })
  | (RevenueCatRecordedEvent & { consumableTransition: RevenueCatConsumableTransition });

export type RevenueCatApplyResult = Readonly<{
  outcome: "applied" | "duplicate" | "stale";
  effectiveState?: RevenueCatTransactionState;
  balanceDelta: ConsumableUnits;
}>;
