//! 比特流读写:定长码字 + 无符号指数哥伦布(ue(v),同 H.264)

pub struct BitWriter {
    pub bytes: Vec<u8>,
    cur: u8,
    nbits: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        BitWriter { bytes: Vec::new(), cur: 0, nbits: 0 }
    }

    #[inline]
    pub fn write_bit(&mut self, b: u32) {
        self.cur = (self.cur << 1) | (b & 1) as u8;
        self.nbits += 1;
        if self.nbits == 8 {
            self.bytes.push(self.cur);
            self.cur = 0;
            self.nbits = 0;
        }
    }

    pub fn write_bits(&mut self, value: u32, n: u32) {
        for i in (0..n).rev() {
            self.write_bit((value >> i) & 1);
        }
    }

    /// 无符号指数哥伦布
    pub fn write_ue(&mut self, mut v: u32) {
        v += 1;
        let n = 32 - v.leading_zeros(); // v+1 的位宽
        for _ in 0..(n - 1) {
            self.write_bit(0);
        }
        self.write_bits(v, n);
    }

    /// 有符号指数哥伦布
    pub fn write_se(&mut self, v: i32) {
        let mapped = if v > 0 { 2 * v - 1 } else { -2 * v } as u32;
        self.write_ue(mapped);
    }

    /// 字节对齐,补 1 后补 0(同 RBSP trailing)
    pub fn byte_align(&mut self) {
        if self.nbits != 0 {
            self.cur = (self.cur << 1) | 1;
            self.nbits += 1;
            while self.nbits < 8 {
                self.cur <<= 1;
                self.nbits += 1;
            }
            self.bytes.push(self.cur);
            self.cur = 0;
            self.nbits = 0;
        }
    }

    pub fn into_bytes(mut self) -> Vec<u8> {
        self.byte_align();
        self.bytes
    }

    pub fn bit_count(&self) -> usize {
        self.bytes.len() * 8 + self.nbits as usize
    }
}

pub struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    cur: u8,
    nbits: u32,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        let mut r = BitReader { data, pos: 0, cur: 0, nbits: 0 };
        r.refill();
        r
    }

    fn refill(&mut self) {
        if self.pos < self.data.len() {
            self.cur = self.data[self.pos];
            self.pos += 1;
            self.nbits = 8;
        } else {
            self.cur = 0;
            self.nbits = 8;
        }
    }

    #[inline]
    pub fn read_bit(&mut self) -> u32 {
        if self.nbits == 0 {
            self.refill();
        }
        self.nbits -= 1;
        ((self.cur >> self.nbits) & 1) as u32
    }

    pub fn read_ue(&mut self) -> u32 {
        let mut zeros = 0u32;
        while self.read_bit() == 0 {
            zeros += 1;
            if zeros > 31 {
                return 0;
            }
        }
        let mut v = 1u32;
        for _ in 0..zeros {
            v = (v << 1) | self.read_bit();
        }
        v - 1
    }

    pub fn read_se(&mut self) -> i32 {
        let u = self.read_ue();
        if u & 1 == 1 {
            ((u + 1) / 2) as i32
        } else {
            -(u as i32 / 2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golomb_roundtrip() {
        let vals = [0u32, 1, 2, 3, 7, 100, 65535, 1_000_000];
        let mut w = BitWriter::new();
        for &v in &vals {
            w.write_ue(v);
        }
        let bytes = w.into_bytes();
        let mut r = BitReader::new(&bytes);
        for &v in &vals {
            assert_eq!(r.read_ue(), v);
        }
    }

    #[test]
    fn signed_golomb() {
        let vals = [0i32, 1, -1, 2, -2, 123, -4567];
        let mut w = BitWriter::new();
        for &v in &vals {
            w.write_se(v);
        }
        let bytes = w.into_bytes();
        let mut r = BitReader::new(&bytes);
        for &v in &vals {
            assert_eq!(r.read_se(), v);
        }
    }
}
