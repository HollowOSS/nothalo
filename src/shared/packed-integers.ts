/** Decode signed deltas stored as unsigned zigzag varints; positions use one stream per axis. */
export function decodeDelta(bytes:Uint8Array,count:number,stride:number):Int32Array {
  const out=new Int32Array(count),previous=new Int32Array(stride)
  let cursor=0
  for(let i=0;i<count;i++){
    let value=0,shift=0,byte=0
    do {
      if(cursor>=bytes.length||shift>28)throw new Error('Invalid packed map integers')
      byte=bytes[cursor++];value|=(byte&127)<<shift;shift+=7
    } while(byte&128)
    const delta=(value>>>1)^-(value&1),axis=i%stride
    out[i]=previous[axis]+delta;previous[axis]=out[i]
  }
  if(cursor!==bytes.length)throw new Error('Unexpected trailing map integers')
  return out
}
