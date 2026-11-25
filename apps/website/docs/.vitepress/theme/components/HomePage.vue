<script setup lang="ts">
import FeatureGrid from './FeatureGrid.vue'
import HomeHero from './HomeHero.vue'
import PhoneDemo from './PhoneDemo.vue'
import ScrollStory from './ScrollStory.vue'
import SiteFooter from './SiteFooter.vue'
</script>

<template>
  <div class="home-page">
    <HomeHero />
    <ScrollStory />
    <FeatureGrid />
    <PhoneDemo />
    <SiteFooter />
  </div>
</template>

<style scoped>
.home-page {
  overflow: clip;
}
</style>
