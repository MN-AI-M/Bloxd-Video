import struct

class AvroReader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def read_raw_varint(self):
        result = 0
        shift = 0
        while True:
            b = self.data[self.pos]
            self.pos += 1
            result |= (b & 0x7f) << shift
            if not (b & 0x80):
                break
            shift += 7
        return result

    def read_long(self):
        n = self.read_raw_varint()
        return (n >> 1) ^ -(n & 1)  # zigzag decode

    def read_int(self):
        return self.read_long()

    def read_boolean(self):
        b = self.data[self.pos]; self.pos += 1
        return b != 0

    def read_float(self):
        v = struct.unpack_from('<f', self.data, self.pos)[0]; self.pos += 4; return v

    def read_double(self):
        v = struct.unpack_from('<d', self.data, self.pos)[0]; self.pos += 8; return v

    def read_bytes(self):
        n = self.read_long()
        b = self.data[self.pos:self.pos+n]; self.pos += n
        return b

    def read_string(self):
        return self.read_bytes().decode('utf-8')

    def read_array(self, item_reader):
        items = []
        while True:
            count = self.read_long()
            if count == 0:
                break
            if count < 0:
                count = -count
                self.read_long()  # block byte-size, ignore
            for _ in range(count):
                items.append(item_reader())
        return items

    def read_map(self, value_reader):
        result = {}
        while True:
            count = self.read_long()
            if count == 0:
                break
            if count < 0:
                count = -count
                self.read_long()
            for _ in range(count):
                k = self.read_string()
                v = value_reader()
                result[k] = v
        return result

    def read_union(self, readers):
        idx = self.read_long()
        return readers[idx]()

    def tell(self):
        return self.pos
