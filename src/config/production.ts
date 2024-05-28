export const config = {
  backendUrl:
    process?.env?.BACKEND_URL || 'https://dashboard.k8s.prd.nos.ci/api',
  backendSolanaAddress:
    process?.env?.BACKEND_SOLANA_ADDRESS ||
    '7rFPFnxjXHC2sfDy3qrDa9pEb4j49oivMuV7e8sYDPmB',
  signMessage: process?.env?.SIGN_MESSAGE || 'Hello Nosana Node!',
};