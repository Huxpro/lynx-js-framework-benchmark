<script setup lang="ts">
declare const lynx: {
  __globalProps?: {
    listRows?: number | string;
    queryItems?: { listRows?: number | string };
  };
};

const DEFAULT_ROWS = 10_000;
const requested = Number(
  lynx.__globalProps?.listRows
    ?? lynx.__globalProps?.queryItems?.listRows
    ?? DEFAULT_ROWS,
);
const rowCount = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_ROWS;
const rows = Array.from({ length: rowCount }, (_, index) => index + 1);
</script>

<template>
  <view class="list-page" style="width: 390px; height: 640px; background-color: #fff">
    <list
      class="list-surface"
      style="width: 390px; height: 640px"
      list-type="single"
      scroll-y
    >
      <list-item
        v-for="id in rows"
        :key="id"
        :item-key="String(id)"
        :estimated-main-axis-size-px="40"
        style="width: 390px; height: 40px"
      >
        <view
          class="list-cell"
          style="width: 390px; height: 40px; display: flex; flex-direction: row; align-items: center; border-bottom-width: 1px; border-bottom-color: #e6e8eb; padding-left: 12px; padding-right: 12px"
        >
          <text class="list-cell-key" style="width: 72px; font-size: 14px; color: #111827">
            {{ id }}
          </text>
          <text class="list-cell-label" style="font-size: 14px; color: #4b5563">
            row {{ id }}
          </text>
        </view>
      </list-item>
    </list>
  </view>
</template>

<style>
.list-page {
  width: 390px;
  height: 640px;
  background-color: #fff;
}

.list-surface {
  width: 390px;
  height: 640px;
}

list-item {
  width: 390px;
  height: 40px;
}

.list-cell {
  width: 390px;
  height: 40px;
  display: flex;
  flex-direction: row;
  align-items: center;
  border-bottom-width: 1px;
  border-bottom-color: #e6e8eb;
  padding-left: 12px;
  padding-right: 12px;
}

.list-cell-key {
  width: 72px;
  font-size: 14px;
  color: #111827;
}

.list-cell-label {
  font-size: 14px;
  color: #4b5563;
}
</style>
