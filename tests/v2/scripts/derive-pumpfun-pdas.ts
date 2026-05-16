import { PublicKey } from '@solana/web3.js';

const PUMPFUN = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const CREATOR = new PublicKey('FNiREuHEmHGZsqdRtJho2xXmH8GKsRw2U4goWxBe6AWL');
const MINT = new PublicKey('CVn4ahK3QqSZGi9gV2BtiZrLZXxGJsJ55DPaEFYzpump');
const FEE_PROG = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

const [creatorVault, cvBump] = PublicKey.findProgramAddressSync(
  [Buffer.from('creator-vault'), CREATOR.toBuffer()], PUMPFUN);
const [bc, bcBump] = PublicKey.findProgramAddressSync(
  [Buffer.from('bonding-curve'), MINT.toBuffer()], PUMPFUN);
const [global] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMPFUN);
const [evAuth] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMPFUN);
const [gva] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMPFUN);
const [feeCfg] = PublicKey.findProgramAddressSync([Buffer.from('fee_config'), PUMPFUN.toBuffer()], FEE_PROG);

console.log('creator_vault PDA:', creatorVault.toBase58(), 'bump', cvBump);
console.log('bonding_curve PDA:', bc.toBase58(), 'bump', bcBump);
console.log('global PDA:', global.toBase58());
console.log('event_authority PDA:', evAuth.toBase58());
console.log('global_volume_accumulator PDA:', gva.toBase58());
console.log('fee_config PDA:', feeCfg.toBase58());
