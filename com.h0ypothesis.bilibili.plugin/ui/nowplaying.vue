<template>
  <v-container class="nowplaying-settings">
    <v-card flat>
      <v-card-title class="text-subtitle-1">
        <v-icon class="mr-2" size="small">mdi-television-play</v-icon>
        {{ $t('NowPlaying.Title') }}
      </v-card-title>

      <v-card-text>
        <v-list density="compact">
          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox v-model="modelValue.data.showTitle" hide-details density="compact" color="#FB7299" @update:modelValue="emitUpdate" />
            </template>
            <v-list-item-title>{{ $t('NowPlaying.UI.ShowTitle') }}</v-list-item-title>
          </v-list-item>

          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox v-model="modelValue.data.showUp" hide-details density="compact" color="#FB7299" @update:modelValue="emitUpdate" />
            </template>
            <v-list-item-title>{{ $t('NowPlaying.UI.ShowUp') }}</v-list-item-title>
          </v-list-item>

          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox v-model="modelValue.data.showCover" hide-details density="compact" color="#FB7299" @update:modelValue="emitUpdate" />
            </template>
            <v-list-item-title>{{ $t('NowPlaying.UI.ShowCover') }}</v-list-item-title>
          </v-list-item>

          <v-list-item>
            <template v-slot:prepend>
              <v-checkbox v-model="modelValue.data.showProgress" hide-details density="compact" color="#FB7299" @update:modelValue="emitUpdate" />
            </template>
            <v-list-item-title>{{ $t('NowPlaying.UI.ShowProgress') }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'NowPlayingSettings',
  props: {
    modelValue: { type: Object, required: true }
  },
  emits: ['update:modelValue'],
  methods: {
    emitUpdate() {
      this.$emit('update:modelValue', this.modelValue);
    },
    initDefaults() {
      if (!this.modelValue.data) this.modelValue.data = {};
      const d = this.modelValue.data;
      if (d.showTitle === undefined) d.showTitle = true;
      if (d.showUp === undefined) d.showUp = true;
      if (d.showCover === undefined) d.showCover = true;
      if (d.showProgress === undefined) d.showProgress = true;
    }
  },
  mounted() {
    this.$fd.info('Bilibili Now Playing settings loaded');
    this.initDefaults();
  }
};
</script>

<style scoped>
.nowplaying-settings {
  padding: 8px;
}
</style>
