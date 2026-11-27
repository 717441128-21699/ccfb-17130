//! HVC(Hive Video Container)二进制容器定义。
//!
//! 文件布局:
//! ```text
//! FileHeader(32B)
//! Frame*  (FrameHeader(16B) + payload)
//! Trailer(32B, magic 反写标识)
//! ```
//! 每个 I 帧即随机访问点;Trailer 记录 I 帧偏移索引,seek 时二分定位。

pub const MAGIC: [u8; 4] = *b"HVC1";
pub const TRAILER_MAGIC: [u8; 4] = *b"1CVH";
pub const VERSION: u32 = 1;

pub const FILE_HEADER_SIZE: usize = 32;
pub const FRAME_HEADER_SIZE: usize = 24;
pub const TRAILER_SIZE: usize = 32;
pub const MAX_INDEX_ENTRIES: usize = 512;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct FileHeader {
    pub width: u32,
    pub height: u32,
    pub padded_width: u32,
    pub padded_height: u32,
    pub fps: u32,
    pub frame_count: u32,
    pub gop: u32,
    pub target_bitrate: u64, // bps,0 表示固定质量模式
}

impl FileHeader {
    pub fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(&self.padded_width.to_le_bytes());
        out.extend_from_slice(&self.padded_height.to_le_bytes());
        out.extend_from_slice(&self.fps.to_le_bytes());
        out.extend_from_slice(&self.frame_count.to_le_bytes());
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct FrameHeader {
    pub frame_index: u32,
    pub qp: u8,
    pub frame_type: u8, // 1=I, 2=P
    pub flags: u8,      // bit0=关键帧冗余
    pub _pad: u8,
    pub payload_bytes: u32, // 熵比特流字节数(不含位图/class 图)
    pub coded_mbs: u32,
    pub bitmap_bytes: u32,
    pub class_map_bytes: u32, // 每 MB 一个 class 字节(解码端重算有效 QP)
}

impl FrameHeader {
    pub fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.frame_index.to_le_bytes());
        out.push(self.qp);
        out.push(self.frame_type);
        out.push(self.flags);
        out.push(self._pad);
        out.extend_from_slice(&self.payload_bytes.to_le_bytes());
        out.extend_from_slice(&self.coded_mbs.to_le_bytes());
        out.extend_from_slice(&self.bitmap_bytes.to_le_bytes());
        out.extend_from_slice(&self.class_map_bytes.to_le_bytes());
    }

    pub fn parse(data: &[u8]) -> Self {
        FrameHeader {
            frame_index: u32::from_le_bytes(data[0..4].try_into().unwrap()),
            qp: data[4],
            frame_type: data[5],
            flags: data[6],
            _pad: data[7],
            payload_bytes: u32::from_le_bytes(data[8..12].try_into().unwrap()),
            coded_mbs: u32::from_le_bytes(data[12..16].try_into().unwrap()),
            bitmap_bytes: u32::from_le_bytes(data[16..20].try_into().unwrap()),
            class_map_bytes: u32::from_le_bytes(data[20..24].try_into().unwrap()),
        }
    }
}

/// Trailer 布局(key 索引在前,32B 定长头固定在文件最末):
/// ```text
/// [ key_offset: u64 ] * key_count
/// [ TRAILER_MAGIC(4) | total_bytes(8) | key_count(4) |
///   target_bitrate(8) | frame_count(4) | reserved(4) ]  // 共 32B
/// ```
/// 这样 magic 永远位于文件末尾,seek 时只需读尾部定长区即可定位。
pub fn write_trailer(
    out: &mut Vec<u8>,
    hdr: &FileHeader,
    total_bytes: u64,
    key_offsets: &[u64],
) {
    // 1) key 偏移数组
    for &off in key_offsets {
        out.extend_from_slice(&off.to_le_bytes());
    }
    // 2) 固定 32B 尾头(位于文件最末)
    let mut head = Vec::with_capacity(TRAILER_SIZE);
    head.extend_from_slice(&TRAILER_MAGIC);
    head.extend_from_slice(&total_bytes.to_le_bytes());
    head.extend_from_slice(&(key_offsets.len() as u32).to_le_bytes());
    head.extend_from_slice(&hdr.target_bitrate.to_le_bytes());
    head.extend_from_slice(&hdr.frame_count.to_le_bytes());
    while head.len() < TRAILER_SIZE {
        head.push(0);
    }
    debug_assert_eq!(head.len(), TRAILER_SIZE);
    out.extend_from_slice(&head);
}

pub struct TrailerInfo {
    pub total_bytes: u64,
    pub key_count: u32,
    pub target_bitrate: u64,
    pub frame_count: u32,
    pub key_offsets: Vec<u64>,
}

pub fn parse_trailer(data: &[u8]) -> Option<TrailerInfo> {
    if data.len() < TRAILER_SIZE {
        return None;
    }
    // 定长尾头固定在文件最末
    let start = data.len() - TRAILER_SIZE;
    if data[start..start + 4] != TRAILER_MAGIC {
        return None;
    }
    let total_bytes = u64::from_le_bytes(data[start + 4..start + 12].try_into().ok()?);
    let key_count = u32::from_le_bytes(data[start + 12..start + 16].try_into().ok()?);
    let target_bitrate = u64::from_le_bytes(data[start + 16..start + 24].try_into().ok()?);
    let frame_count = u32::from_le_bytes(data[start + 24..start + 28].try_into().ok()?);

    // key 偏移数组位于尾头之前,按写入顺序(升序)直接读取
    let index_bytes = key_count as usize * 8;
    let index_end = start;
    let index_start = index_end.checked_sub(index_bytes)?;
    if data.len() < index_start + index_bytes {
        return None;
    }
    let mut key_offsets = Vec::with_capacity(key_count as usize);
    for k in 0..key_count as usize {
        let p = index_start + k * 8;
        key_offsets.push(u64::from_le_bytes(data[p..p + 8].try_into().ok()?));
    }
    Some(TrailerInfo {
        total_bytes,
        key_count,
        target_bitrate,
        frame_count,
        key_offsets,
    })
}
