const chromeLikeUA = navigator.userAgent
  .replace(/\sNWjs\/[\d.]+/i, "")
  .replace(/\sElectron\/[\d.]+/i, "");

export const userAgent = chromeLikeUA;