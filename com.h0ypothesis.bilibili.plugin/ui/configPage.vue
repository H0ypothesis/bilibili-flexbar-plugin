<template>
  <v-container class="bili-config">
    <v-card class="mx-auto" max-width="700">
      <v-card-title class="text-h5 bili-header">
        <v-icon class="mr-2">mdi-television-play</v-icon>
        {{ $t('Config.Title') }}
      </v-card-title>

      <v-stepper v-model="currentStep" :items="stepItems" alt-labels>
        <!-- Step 1: 启动桥接服务 -->
        <template v-slot:item.1>
          <v-card flat>
            <v-card-text>
              <p class="text-body-1 mb-4">{{ $t('Config.Step1.Description') }}</p>
              <v-alert type="info" variant="tonal" class="mb-4">
                <pre class="instructions">{{ $t('Config.Step1.Instructions') }}</pre>
              </v-alert>
              <v-btn color="#FB7299" variant="elevated" @click="copyCommand" prepend-icon="mdi-content-copy">
                {{ $t('Config.Step1.Button') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </template>

        <!-- Step 2: 以调试模式运行哔哩哔哩 -->
        <template v-slot:item.2>
          <v-card flat>
            <v-card-text>
              <p class="text-body-1 mb-4">{{ $t('Config.Step2.Description') }}</p>
              <v-alert
                :type="restartStatus === 'done' ? 'success' : (restartStatus === 'error' ? 'error' : 'info')"
                variant="tonal" class="mb-4">
                <span v-if="restartStatus === 'idle'">{{ $t('Config.Step2.Idle') }}</span>
                <span v-else-if="restartStatus === 'working'">{{ $t('Config.Step2.Working') }}</span>
                <span v-else-if="restartStatus === 'done'">{{ $t('Config.Step2.Done') }}</span>
                <span v-else-if="restartStatus === 'error'">{{ $t('Config.Step2.Error') }}</span>
              </v-alert>
              <v-btn color="#FB7299" variant="elevated" @click="restartDebug"
                :loading="restartStatus === 'working'" prepend-icon="mdi-restart">
                {{ $t('Config.Step2.Button') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </template>

        <!-- Step 3: 测试连接 -->
        <template v-slot:item.3>
          <v-card flat>
            <v-card-text>
              <p class="text-body-1 mb-4">{{ $t('Config.Step3.Description') }}</p>
              <v-alert
                :type="connectionStatus === 'connected' ? 'success' : (connectionStatus === 'error' ? 'error' : 'warning')"
                variant="tonal" class="mb-4">
                <div class="d-flex align-center">
                  <span v-if="connectionStatus === 'idle'">{{ $t('Config.Step3.Idle') }}</span>
                  <span v-else-if="connectionStatus === 'testing'">{{ $t('Config.Step3.Testing') }}</span>
                  <span v-else-if="connectionStatus === 'connected'">
                    {{ $t('Config.Step3.Connected') }}
                    <span v-if="currentTitle" class="ml-2">- {{ currentTitle }}</span>
                  </span>
                  <span v-else-if="connectionStatus === 'error'">{{ $t('Config.Step3.NotConnected') }}</span>
                </div>
              </v-alert>
              <v-btn color="#FB7299" variant="elevated" @click="testConnection"
                :loading="connectionStatus === 'testing'" prepend-icon="mdi-connection">
                {{ $t('Config.Step3.Button') }}
              </v-btn>
            </v-card-text>
          </v-card>
        </template>

        <template v-slot:actions>
          <v-stepper-actions
            @click:prev="currentStep--"
            @click:next="handleNext"
            :prev-text="$t('Config.Back')"
            :next-text="currentStep === 3 ? $t('Config.Finish') : $t('Config.Next')" />
        </template>
      </v-stepper>
    </v-card>
  </v-container>
</template>

<script>
export default {
  name: 'ConfigPage',
  data() {
    return {
      currentStep: 1,
      restartStatus: 'idle',     // idle, working, done, error
      connectionStatus: 'idle',  // idle, testing, connected, error
      currentTitle: ''
    };
  },
  computed: {
    stepItems() {
      return [
        { title: this.$t('Config.Step1.Title'), value: 1 },
        { title: this.$t('Config.Step2.Title'), value: 2 },
        { title: this.$t('Config.Step3.Title'), value: 3 }
      ];
    }
  },
  methods: {
    async copyCommand() {
      const cmd = 'npm run macos:bridge';
      try {
        if (navigator && navigator.clipboard) await navigator.clipboard.writeText(cmd);
        this.$fd.info('已复制: ' + cmd);
      } catch (e) {
        this.$fd.error('复制失败: ' + e.message);
      }
    },
    async restartDebug() {
      this.restartStatus = 'working';
      try {
        const res = await this.$fd.sendToBackend({ action: 'restartBilibiliDebug' });
        this.restartStatus = res && res.success ? 'done' : 'error';
      } catch (e) {
        this.restartStatus = 'error';
        this.$fd.error(e.message);
      }
    },
    async testConnection() {
      this.connectionStatus = 'testing';
      try {
        const res = await this.$fd.sendToBackend({ action: 'getConnectionStatus' });
        if (res && res.connected) {
          this.connectionStatus = 'connected';
          this.currentTitle = res.currentTitle || '';
        } else {
          this.connectionStatus = 'error';
        }
      } catch (e) {
        this.connectionStatus = 'error';
        this.$fd.error(e.message);
      }
    },
    handleNext() {
      if (this.currentStep === 3) { this.$fd.info(this.$t('Config.Complete')); return; }
      this.currentStep++;
    },
    async checkInitialConnection() {
      try {
        const res = await this.$fd.sendToBackend({ action: 'getConnectionStatus' });
        if (res && res.connected) {
          this.connectionStatus = 'connected';
          this.currentTitle = res.currentTitle || '';
        }
      } catch (e) { /* 忽略 */ }
    }
  },
  mounted() {
    this.$fd.info('Bilibili Config Page loaded');
    this.checkInitialConnection();
  }
};
</script>

<style scoped>
.bili-config {
  padding: 16px;
}
.bili-header {
  background: linear-gradient(135deg, #FB7299 0%, #00AEEC 100%);
  color: white;
}
.instructions {
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  margin: 0;
}
</style>
