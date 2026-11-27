//! MSB-first 比特读写器。

pub struct BitWriter {
    pub buf: Vec<u8>,
    acc: u32,
    n: u32, // acc 中有效位数
}

impl BitWriter {
    pub fn new(cap: usize) -> Self {
        BitWriter {
            buf: Vec::with_capacity(cap),
            acc: 0,
            n: 0,
        }
    }

    #[inline]
    pub fn write(&mut self, bits: u32, len: u32) {
        debug_assert!(len <= 16);
        self.acc = (self.acc << len) | (bits & ((1u32 << len).wrapping_sub(1)));
        self.n += len;
        while self.n >= 8 {
            self.n -= 8;
            self.buf.push((self.acc >> self.n) as u8);
        }
    }

    /// 写入带符号幅度值(JPEG 风格:负数写 v-1 的低 cat 位)。
    #[inline]
    pub fn write_signed(&mut self, v: i32, cat: u32) {
        if cat == 0 {
            return;
        }
        let bits = if v >= 0 {
            v
        } else {
            v - 1
        };
        self.write((bits as u32) & ((1u32 << cat) - 1), cat);
    }

    /// 字节对齐,末字节不足 8 位时补 1(JPEG 填充风格)。
    pub fn flush(&mut self) {
        if self.n > 0 {
            let pad = 8 - self.n;
            self.acc = (self.acc << pad) | ((1u32 << pad) - 1);
            self.buf.push(self.acc as u8);
            self.acc = 0;
            self.n = 0;
        }
    }

    pub fn byte_len(&self) -> usize {
        self.buf.len()
    }
}

pub struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    acc: u32,
    n: u32,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        BitReader {
            data,
            pos: 0,
            acc: 0,
            n: 0,
        }
    }

    #[inline]
    pub fn read1(&mut self) -> u32 {
        if self.n == 0 {
            self.acc = if self.pos < self.data.len() {
                self.data[self.pos] as u32
            } else {
                0xff
            }; // 越界按填充 1 处理
            self.pos += 1;
            self.n = 8;
        }
        self.n -= 1;
        (self.acc >> self.n) & 1
    }

    #[inline]
    pub fn read(&mut self, len: u32) -> u32 {
        let mut v = 0u32;
        for _ in 0..len {
            v = (v << 1) | self.read1();
        }
        v
    }

    #[inline]
    pub fn read_signed(&mut self, cat: u32) -> i32 {
        if cat == 0 {
            return 0;
        }
        let v = self.read(cat) as i32;
        // 高位为 0 表示负数(JPEG 约定)
        if v < (1 << (cat - 1)) {
            v - (1i32 << cat) + 1
        } else {
            v
        }
    }

    pub fn align(&mut self) {
        self.n = 0;
    }
}

/// 带符号整数的二进制位数类别(JPEG category)。
#[inline]
pub fn category(v: i32) -> u32 {
    let a = v.unsigned_abs();
    32 - a.leading_zeros()
}
